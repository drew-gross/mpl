import { errors } from '../runtime-strings.js';
import { mallocWithMmap, length, stringCopy, KnownRegisters } from './registerTransferLanguageRuntime.js';
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
start:    mov       ,          ; system call for write
          mov       rdi, 1                  ; file handle 1 is stdout
          mov       rsi, message            ; address of string to output
          mov       rdx, 13                 ; number of bytes
          syscall                           ; invoke operating system to do the write
          mov       rax,          ; system call for exit
          mov       rdi, 3                ; exit code 3
          syscall                           ; invoke operating system to exit

          section   .data
message:  db        "Hello, World", 10      ; note the newline at the end
`;

// TODO: unify with named registers in mips. Args are r8-r10, general purpose starts at r11.
const firstRegister: StorageSpec = {
    type: 'register',
    destination: 'r8',
};

const knownRegisters: KnownRegisters = {
    argument1: { type: 'register', destination: 'r8' },
    argument2: { type: 'register', destination: 'r9' },
    argument3: { type: 'register', destination: 'r10' },
    functionResult: { type: 'register', destination: 'rax' },
    syscallArg1: { type: 'register', destination: 'rdi' },
    syscallArg2: { type: 'register', destination: 'rsi' },
    syscallArg3: { type: 'register', destination: 'rdx' },
    syscallArg4: { type: 'register', destination: 'rcx' },
    syscallArg5: { type: 'register', destination: 'r8' },
    syscallArg6: { type: 'register', destination: 'r9' },
    syscallSelect: { type: 'register', destination: 'rax' },
    syscallResult: { type: 'register', destination: 'rax' },
};

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
        case 'typedDeclarationAssignment':
        case 'stringLiteral':
            return astToRegisterTransferLanguage(input, knownRegisters, nextTemporary, makeLabel, recurse);
        case 'identifier': {
            // TODO: Better handle identifiers here. Also just better storage/scope chains?
            const identifierName = ast.value;
            if (globalDeclarations.some(declaration => declaration.name === identifierName)) {
                const declaration = globalDeclarations.find(declaration => declaration.name === identifierName);
                if (!declaration) throw debug('todo');
                debugger;
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
                    from: leftSideDestination,
                    to: { type: 'register', destination: 'rax' },
                    why: 'Multiply does rax * arg',
                },
                `mul ${(rightSideDestination as any).destination}`,
                {
                    kind: 'move',
                    from: { type: 'register', destination: 'rax' },
                    to: destination,
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
            if (rtx.to.type !== 'register') throw debug('todo');
            if (rtx.from.type !== 'register') throw debug('todo');
            return [`mov ${rtx.to.destination}, ${rtx.from.destination}; ${rtx.why}`];
        case 'returnValue':
            if (rtx.source.type !== 'register') throw debug('todo');
            return [`mov ${knownRegisters.functionResult.destination}, ${rtx.source.destination}; ${rtx.why}`];
        case 'subtract':
            if (rtx.lhs.type !== 'register') throw debug('todo');
            if (rtx.rhs.type !== 'register') throw debug('todo');
            if (rtx.destination.type !== 'register') throw debug('todo');
            return [
                `mov ${rtx.destination.destination}, ${rtx.lhs.destination}`,
                `sub ${rtx.destination.destination}, ${rtx.rhs.destination}`,
            ];
        case 'increment':
            return [`inc ${rtx.register};`];
        case 'addImmediate':
            return [`add ${rtx.register}, ${rtx.amount}`];
        case 'gotoIfEqual':
            if (rtx.lhs.type !== 'register' || rtx.rhs.type !== 'register') throw debug('todo');
            return [`cmp ${rtx.lhs.destination}, ${rtx.rhs.destination}`, `je ${rtx.label}`];
        case 'gotoIfNotEqual':
            if (rtx.lhs.type !== 'register' || rtx.rhs.type !== 'register') throw debug('todo');
            return [`cmp ${rtx.lhs.destination}, ${rtx.rhs.destination}`, `jne ${rtx.label}`];
        case 'gotoIfZero':
            if (rtx.register.type !== 'register') throw debug('todo');
            return [`cmp ${rtx.register.destination}, 0`, `jz ${rtx.label}`];
        case 'gotoIfGreater':
            if (rtx.lhs.type !== 'register' || rtx.rhs.type !== 'register') throw debug('todo');
            return [`cmp ${rtx.lhs.destination}, ${rtx.rhs.destination}`, `jg ${rtx.label}`];
        case 'goto':
            return [`jmp ${rtx.label}`];
        case 'label':
            return [`${rtx.name}:`];
        case 'functionLabel':
            return [`${rtx.name}:`];
        case 'storeGlobal':
            if (rtx.to.type !== 'register') throw debug('todo');
            if (rtx.from.type !== 'register') throw debug('todo');
            return [`mov [rel ${rtx.to.destination}], ${rtx.from.destination}; ${rtx.why}`];
        case 'loadGlobal':
            if (rtx.to.type !== 'register') throw debug('todo');
            return [`mov ${rtx.to.destination}, [rel ${rtx.from}]; ${rtx.why}`];
        case 'loadMemory':
            if (rtx.to.type !== 'register') throw debug('todo');
            if (rtx.from.type !== 'register') throw debug('todo');
            return [`mov ${rtx.to.destination}, [${rtx.from.destination}]`];
        case 'storeMemory':
            if (rtx.address.type !== 'register') throw debug('todo');
            if (rtx.from.type !== 'register') throw debug('todo');
            return [`mov [${rtx.address.destination}], ${rtx.from.destination}`];
        case 'storeZeroToMemory':
            if (rtx.address.type !== 'register') throw debug('todo');
            return [`mov byte [${rtx.address.destination}], 0`];
        case 'storeMemoryByte':
            if (rtx.contents.type !== 'register') throw debug('Need a register');
            if (rtx.address.type !== 'register') throw debug('Need a register');
            return [`mov byte [${rtx.address.destination}], ${rtx.contents.destination}b`];
        case 'loadMemoryByte':
            if (rtx.to.type !== 'register') throw debug('todo');
            if (rtx.address.type !== 'register') throw debug('todo');
            return [`movsx ${rtx.to.destination}, byte [${rtx.address.destination}]`];
        case 'loadSymbolAddress':
            if (rtx.to.type !== 'register') throw debug('todo');
            return [`mov ${rtx.to.destination}, ${rtx.symbolName}; ${rtx.why}`];
        case 'call':
            return [`call ${rtx.function}; ${rtx.why}`];
        case 'returnToCaller':
            return [`ret`];
        case 'syscall':
            return [`syscall`];
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
        result.push(`pop r${numRegisters + 7}`);
        numRegisters--;
    }
    return result.reverse();
};

const bytesInWord = 8;
const syscallNumbers = {
    print: 0x02000004,
    sbrk: 0x02000045,
    exit: 0x02000001,
    mmap: 0x020000c5,
};

const runtimeFunctions: RegisterTransferLanguageExpression[][] = [
    length(
        bytesInWord,
        syscallNumbers,
        saveRegistersCode,
        restoreRegistersCode,
        knownRegisters,
        firstRegister,
        nextTemporary
    ),
    //printRuntimeFunction(),
    //stringEqualityRuntimeFunction(),
    stringCopy(
        bytesInWord,
        syscallNumbers,
        saveRegistersCode,
        restoreRegistersCode,
        knownRegisters,
        firstRegister,
        nextTemporary
    ),
    mallocWithMmap(
        bytesInWord,
        syscallNumbers,
        saveRegistersCode,
        restoreRegistersCode,
        knownRegisters,
        firstRegister,
        nextTemporary
    ),
    //myFreeRuntimeFunction(),
    //stringConcatenateRuntimeFunction(),
    //verifyNoLeaks(),
];

const stringLiteralDeclaration = (literal: StringLiteralData) =>
    `${stringLiteralName(literal)}: db "${literal.value}", 10;`;

const toExectuable = ({ functions, program, globalDeclarations, stringLiterals }: BackendInputs) => {
    let x64Functions: RegisterTransferLanguageExpression[][] = functions.map(f =>
        constructFunction(
            f,
            astToX64,
            globalDeclarations,
            stringLiterals,
            knownRegisters.functionResult.destination,
            [
                knownRegisters.argument1.destination,
                knownRegisters.argument2.destination,
                knownRegisters.argument3.destination,
            ],
            firstRegister,
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
${join(flatten(flatten(runtimeFunctions).map(registerTransferExpressionToX64)), '\n')}

start:
${join(flatten(x64Program.map(registerTransferExpressionToX64)), '\n')}
    mov rdi, rax; Move function call result to syscall arg
    mov rax, 0x02000001; system call for exit
    syscall

section .data
first_block: dq 0
message: db "Must have writable segment", 10; newline mandatory. This exists to squelch dyld errors
${join(stringLiterals.map(stringLiteralDeclaration), '\n')}
section .bss
${globalDeclarations.map(name => `${name.name}: resd 1`).join('\n')}
${Object.keys(errors)
        .map(key => `${errors[key].name}: resd 1`)
        .join('\n')}
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
