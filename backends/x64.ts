import join from '../util/join.js';
import { isEqual } from 'lodash';
import debug from '../util/debug.js';
import * as Ast from '../ast.js';
import {
    BackendOptions,
    CompiledProgram,
    StorageSpec,
    RegisterAssignment,
    compileExpression,
    storageSpecToString,
    stringLiteralName,
} from '../backend-utils.js';
import {
    astToRegisterTransferLanguage,
    constructFunction,
    PureRegisterTransferLanguageExpression,
    RegisterTransferLanguageExpression,
} from './registerTransferLanguage.js';
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

// TODO: unify with named registers in mips. Args are r8-r10, general purpose starts at r11.
const functionResult = 'rax';
const argument1 = 'r8';
const argument2 = 'r9';
const argument3 = 'r10';

// TOOD: Unify with nextTemporary in mips
const nextTemporary = (storage: StorageSpec): StorageSpec => {
    if (storage.type == 'register') {
        if (storage.destination == 'r15') {
            // Now need to spill
            return {
                type: 'memory',
                spOffset: 0,
            };
        } else {
            return {
                type: 'register',
                destination: `r${parseInt(storage.destination.slice(1)) + 1}`,
            };
        }
    } else if (storage.type == 'memory') {
        return {
            type: 'memory',
            spOffset: storage.spOffset + 4,
        };
    } else {
        return debug('todo');
    }
};

let labelId = 0;

const astToX64 = (input: BackendOptions): CompiledProgram => {
    const { ast, registerAssignment, destination, currentTemporary, globalDeclarations, stringLiterals } = input;
    if (isEqual(currentTemporary, destination)) throw debug('todo'); // Sanity check to make sure caller remembered to provide a new temporary
    const recurse = newInput => astToX64({ ...input, ...newInput });
    const makeLabel = (name: string) => {
        const result = `${name}${labelId}`;
        labelId++;
        return result;
    };
    if (!ast) debug('todo');
    switch (ast.kind) {
        case 'number':
        case 'returnStatement':
        case 'subtraction':
        case 'ternary':
        case 'booleanLiteral':
        case 'functionLiteral':
        case 'callExpression':
        case 'equality':
        case 'stringLiteral':
            return astToRegisterTransferLanguage(
                input,
                {
                    argument1: argument1,
                    argument2: argument2,
                    argument3: argument3,
                    functionResult: functionResult,
                },
                nextTemporary,
                makeLabel,
                recurse
            );
        case 'typedDeclarationAssignment': {
            const lhs = ast.destination;
            if (globalDeclarations.some(declaration => declaration.name === lhs)) {
                const subExpressionTemporary = nextTemporary(currentTemporary);
                const rhs = recurse({
                    ast: ast.expression,
                    destination: currentTemporary,
                    currentTemporary: subExpressionTemporary,
                });
                const declaration = globalDeclarations.find(declaration => declaration.name === lhs);
                if (!declaration) throw debug('todo');
                if (currentTemporary.type !== 'register') throw debug('todo');
                switch (declaration.type.name) {
                    case 'Function':
                    case 'Integer':
                        return compileExpression([rhs], ([e1]) => [
                            `; Put ${declaration.type.name} into temporary`,
                            ...e1,
                            {
                                kind: 'storeGlobal',
                                from: currentTemporary.destination,
                                to: lhs,
                                why: `Put ${declaration.type.name} into global`,
                            },
                        ]);
                    default:
                        throw debug(`${declaration.type.name} unhandled in astToX64.typedDeclarationAssignment`);
                }
            } else if (lhs in registerAssignment) {
                return recurse({
                    ast: ast.expression,
                    // TODO: Allow spilling of variables
                    destination: {
                        type: 'register',
                        destination: `${(registerAssignment[lhs] as any).destination}`,
                    },
                });
            } else {
                throw debug('todo');
            }
        }
        case 'identifier': {
            // TODO: Better handle identifiers here. Also just better storage/scope chains?
            const identifierName = ast.value;
            if (globalDeclarations.some(declaration => declaration.name === identifierName)) {
                const declaration = globalDeclarations.find(declaration => declaration.name === identifierName);
                if (!declaration) throw debug('todo');
                return compileExpression([], ([]) => [
                    {
                        kind: 'loadGlobal',
                        from: identifierName,
                        to: destination,
                        why: `Move from global ${identifierName} into destination (${(destination as any).destination ||
                            (destination as any).spOffset})`,
                    },
                ]);
            }
            const identifierRegister = (registerAssignment[identifierName] as any).destination;
            return compileExpression([], ([]) => [
                {
                    kind: 'move',
                    to: (destination as any).destination,
                    from: identifierRegister,
                    why: `Move from ${identifierName} (${identifierRegister}) into destination (${(destination as any)
                        .destination || (destination as any).spOffset})`,
                },
            ]);
        }
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
            throw debug(`${ast.kind} unhandled in astToX64`);
    }
};

// TODO: unify with assignMipsRegisters
const assignX64Registers = (
    variables: VariableDeclaration[]
): { registerAssignment: RegisterAssignment; firstTemporary: StorageSpec } => {
    // TODO: allow spilling of variables
    let currentRegister = 11;
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

const registerTransferExpressionToX64 = (rtx: RegisterTransferLanguageExpression): string[] => {
    if (typeof rtx == 'string') return [rtx];
    switch (rtx.kind) {
        case 'comment':
            return [`; ${rtx.why}`];
        case 'loadImmediate':
            if (rtx.destination.type !== 'register') throw debug('todo');
            return [`mov ${rtx.destination.destination}, ${rtx.value}; ${rtx.why}`];
        case 'move':
            return [`mov ${rtx.to}, ${rtx.from}; ${rtx.why}`];
        case 'returnValue':
            if (rtx.source.type !== 'register') throw debug('todo');
            return [`mov ${functionResult}, ${rtx.source.destination}; ${rtx.why}`];
        case 'subtract':
            if (rtx.lhs.type !== 'register') throw debug('todo');
            if (rtx.rhs.type !== 'register') throw debug('todo');
            if (rtx.destination.type !== 'register') throw debug('todo');
            return [
                `mov ${rtx.destination.destination}, ${rtx.lhs.destination}`,
                `sub ${rtx.destination.destination}, ${rtx.rhs.destination}`,
            ];
        case 'gotoIfEqual':
            if (rtx.lhs.type !== 'register' || rtx.rhs.type !== 'register') throw debug('todo');
            return [`cmp ${rtx.lhs.destination}, ${rtx.rhs.destination}`, `je ${rtx.label}`];
        case 'goto':
            return [`jmp ${rtx.label}`];
        case 'label':
            return [`${rtx.name}:`];
        case 'functionLabel':
            return [`${rtx.name}:`];
        case 'storeGlobal':
            return [`mov [rel ${rtx.to}], ${rtx.from}; ${rtx.why}`];
        case 'loadGlobal':
            if (rtx.to.type !== 'register') throw debug('todo');
            return [`mov ${rtx.to.destination}, [rel ${rtx.from}]; ${rtx.why}`];
        case 'loadSymbolAddress':
            if (rtx.to.type !== 'register') throw debug('todo');
            return [`mov ${rtx.to.destination}, ${rtx.symbolName}; ${rtx.why}`];
        case 'call':
            return [`call ${rtx.function}; ${rtx.why}`];
        case 'returnToCaller':
            return [`ret`];
        default:
            throw debug(`${(rtx as any).kind} unhandled in registerTransferExpressionToX64`);
    }
};

const saveRegistersCode = (numRegisters: number): string[] => {
    let result: string[] = [];
    while (numRegisters > 0) {
        result.push(`push r${numRegisters + 7}`);
        numRegisters--;
    }
    return result;
};

const restoreRegistersCode = (numRegisters: number): string[] => {
    let result: string[] = [];
    while (numRegisters > 0) {
        result.push(`pop r${numRegisters + 7}, ($sp)`);
        numRegisters--;
    }
    return result.reverse();
};

const toExectuable = ({ functions, program, globalDeclarations, stringLiterals }: BackendInputs) => {
    let x64Functions: RegisterTransferLanguageExpression[][] = functions.map(f =>
        constructFunction(
            f,
            astToX64,
            globalDeclarations,
            stringLiterals,
            functionResult,
            [argument1, argument2, argument3],
            {
                type: 'register',
                destination: 'r8',
            },
            nextTemporary,
            saveRegistersCode,
            restoreRegistersCode
        )
    );
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
${join(flatten(flatten(x64Functions).map(registerTransferExpressionToX64)), '\n')}

start:
${join(flatten(x64Program.map(registerTransferExpressionToX64)), '\n')}
    mov rdi, rax; Move function call result to syscall arg
    mov rax, 0x02000001; system call for exit
    syscall

section .data
message:
    db "Must have writable segment", 10; newline mandatory. This exists to squelch dyld errors
section .bss
${globalDeclarations.map(name => `${name.name}: resd 1`).join('\n')}
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
