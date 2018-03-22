import join from '../util/join.js';
import { isEqual } from 'lodash';
import debug from '../util/debug.js';
import * as Ast from '../ast.js';
import {
    RegisterTransferLanguageExpression,
    astToRegisterTransferLanguage,
    BackendOptions,
    CompiledProgram,
    StorageSpec,
    RegisterAssignment,
    compileExpression,
    storageSpecToString,
} from '../backend-utils.js';
import flatten from '../util/list/flatten.js';
import { VariableDeclaration, BackendInputs, StringLiteralData } from '../api.js';
import { exec } from 'child-process-promise';
import { file as tmpFile } from 'tmp-promise';
import execAndGetResult from '../util/execAndGetResult.js';

const sample = `
; ----------------------------------------------------------------------------------------
; Writes "Hello, World" to the console using only system calls. Runs on 64-bit macOS only.
; ----------------------------------------------------------------------------------------

          global    start

          section   .text
start:    mov       rax, 0x02000004         ; system call for write
          mov       rdi, 1                  ; file handle 1 is stdout
          mov       rsi, message            ; address of string to output
          mov       rdx, 13                 ; number of bytes
          syscall                           ; invoke operating system to do the write
          mov       rax, 0x02000001         ; system call for exit
          mov       rdi, 3                ; exit code 3
          syscall                           ; invoke operating system to exit

          section   .data
message:  db        "Hello, World", 10      ; note the newline at the end
`;

// TODO: unify with named registers in mips
const functionResult = 'rax';

// TOOD: Unify with nextTemporary in mips
const nextTemporary = (storage: StorageSpec): StorageSpec => {
    if (storage.type == 'register') {
        if (storage.destination == '%r15') {
            // Now need to spill
            return {
                type: 'memory',
                spOffset: 0,
            };
        } else {
            return {
                type: 'register',
                // TODO: handle registers with numbers > 9
                destination: `r${parseInt(storage.destination[storage.destination.length - 1]) + 1}`,
            };
        }
    } else if (storage.type == 'memory') {
        return {
            type: 'memory',
            spOffset: storage.spOffset + 4,
        };
    } else {
        return debug();
    }
};

const astToX64 = (input: BackendOptions): CompiledProgram => {
    const { ast, registerAssignment, destination, currentTemporary, globalDeclarations, stringLiterals } = input;
    if (isEqual(currentTemporary, destination)) throw debug(); // Sanity check to make sure caller remembered to provide a new temporary
    const recurse = newInput => astToX64({ ...input, ...newInput });
    if (!ast) debug();
    switch (ast.kind) {
        case 'number':
        case 'returnStatement':
            return astToRegisterTransferLanguage(input, nextTemporary, recurse);
        case 'product': {
            const leftSideDestination: StorageSpec = currentTemporary;
            const rightSideDestination = destination;
            const subExpressionTemporary = nextTemporary(currentTemporary);

            const storeLeftInstructions = recurse({
                ast: ast.lhs,
                destination: leftSideDestination,
                currentTemporary: subExpressionTemporary,
            });
            const storeRightInstructions = recurse({
                ast: ast.rhs,
                destination: rightSideDestination,
                currentTemporary: subExpressionTemporary,
            });
            return compileExpression([storeLeftInstructions, storeRightInstructions], ([storeLeft, storeRight]) => [
                `; Store left side of product in temporary (${storageSpecToString(leftSideDestination)})`,
                ...storeLeft,
                `; Store right side of product in destination (${storageSpecToString(rightSideDestination)})`,
                ...storeRight,
                {
                    kind: 'move',
                    from: (leftSideDestination as any).destination,
                    to: 'rax',
                    why: 'Multiply does rax * arg',
                },
                `mul ${(rightSideDestination as any).destination}`,
                {
                    kind: 'move',
                    from: 'rax',
                    to: (destination as any).destination,
                    why: 'Multiply puts result in rax:rdx, move it to final destination',
                },
            ]);
        }
        default:
            throw debug();
    }
};

// TODO: unify with assignMipsRegisters
const assignX64Registers = (
    variables: VariableDeclaration[]
): { registerAssignment: RegisterAssignment; firstTemporary: StorageSpec } => {
    // TODO: allow spilling of variables
    let currentRegister = 8;
    let registerAssignment = {};
    variables.forEach(variable => {
        registerAssignment[variable.name] = {
            type: 'register',
            destination: `r${currentRegister}`,
        };
        currentRegister = currentRegister + 1;
    });
    return {
        registerAssignment,
        firstTemporary: {
            type: 'register',
            destination: `r${currentRegister}`,
        },
    };
};

const registerTransferExpressionToX64 = (rtx: RegisterTransferLanguageExpression): string => {
    if (typeof rtx == 'string') return rtx;
    switch (rtx.kind) {
        case 'loadImmediate':
            if (rtx.destination.type !== 'register') throw debug();
            return `mov ${rtx.destination.destination}, ${rtx.value}; ${rtx.why}`;
        case 'move':
            return `mov ${rtx.to}, ${rtx.from}; ${rtx.why}`;
        case 'return':
            if (rtx.source.type !== 'register') throw debug();
            return `mov ${functionResult}, ${rtx.source.destination}; ${rtx.why}`;
        default:
            throw debug();
    }
};

const toExectuable = ({ functions, program, globalDeclarations, stringLiterals }: BackendInputs) => {
    const { registerAssignment, firstTemporary } = assignX64Registers(program.variables);
    let x64Program = flatten(
        program.statements.map(statement => {
            const compiledProgram = astToX64({
                ast: statement,
                registerAssignment,
                destination: {
                    type: 'register',
                    destination: '$a0',
                },
                currentTemporary: firstTemporary,
                globalDeclarations,
                stringLiterals,
            });

            return [...compiledProgram.prepare, ...compiledProgram.execute, ...compiledProgram.cleanup];
        })
    );

    return `
global start

section .text
start:
${join(x64Program.map(registerTransferExpressionToX64), '\n')}
    mov rdi, rax; Move function call result to syscall arg
    mov rax, 0x02000001; system call for exit
    syscall

section .data
message:
    db "Must have writable segment", 10; newline mandatory. This exists to squelch dyld errors
`;
};

export default {
    name: 'x64',
    toExectuable,
    execute: async path => {
        const linkerInputPath = await tmpFile({ postfix: '.o' });
        const exePath = await tmpFile({ postfix: '.out' });
        await exec(`nasm -fmacho64 -o ${linkerInputPath.path} ${path}`);
        await exec(`ld -o ${exePath.path} ${linkerInputPath.path}`);
        return execAndGetResult(exePath.path);
    },
};
