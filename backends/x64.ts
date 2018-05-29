import { errors } from '../runtime-strings.js';
import {
    mallocWithMmap,
    length,
    stringCopy,
    verifyNoLeaks,
    printWithWriteRuntimeFunction,
    myFreeRuntimeFunction,
    stringEqualityRuntimeFunction,
    stringConcatenateRuntimeFunction,
} from './registerTransferLanguageRuntime.js';
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
    saveRegistersCode,
    restoreRegistersCode,
} from '../backend-utils.js';
import {
    astToRegisterTransferLanguage,
    constructFunction,
    RegisterTransferLanguageExpression,
    RegisterTransferLanguageFunction,
} from './registerTransferLanguage.js';
import flatten from '../util/list/flatten.js';
import { VariableDeclaration, BackendInputs, StringLiteralData } from '../api.js';
import { exec } from 'child-process-promise';
import { file as tmpFile } from 'tmp-promise';
import execAndGetResult from '../util/execAndGetResult.js';
import { execSync } from 'child_process';

// TODO: unify with named registers in mips. Args are r8-r10, general purpose starts at r11.
const firstRegister: StorageSpec = {
    type: 'register',
    destination: 'r11',
};

// TOOD: Unify with nextTemporary in mips. Also be able to use special purpose registers like rdx when not multiplying.
const nextTemporary = (storage: StorageSpec): StorageSpec => {
    if (typeof storage == 'string') throw debug('nextTemporary not valid for special registers');
    if (storage.type == 'register') {
        if (storage.destination == 'r15') {
            return {
                type: 'register',
                destination: 'rdi',
            };
        } else if (storage.destination == 'rdi') {
            return {
                type: 'register',
                destination: 'rsi',
            };
        } else if (storage.destination == 'rsi') {
            return {
                type: 'register',
                destination: 'rbx',
            };
        } else if (storage.destination == 'rbx') {
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
const makeLabel = (name: string) => {
    const result = `${name}${labelId}`;
    labelId++;
    return result;
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

const specialRegisterNames = {
    functionArgument1: 'r8',
    functionArgument2: 'r9',
    functionArgument3: 'r10',
    functionResult: 'rax',
};
const getRegisterName = (r: StorageSpec): string => {
    if (typeof r == 'string') return specialRegisterNames[r];
    if (r.type == 'memory') throw debug('spilling not supported in x64 yet');
    return r.destination;
};

const registerTransferExpressionToX64WithoutComment = (rtx: RegisterTransferLanguageExpression): string[] => {
    switch (rtx.kind) {
        case 'comment':
            return [''];
        case 'loadImmediate':
            return [`mov ${getRegisterName(rtx.destination)}, ${rtx.value}`];
        case 'move':
            return [`mov ${getRegisterName(rtx.to)}, ${getRegisterName(rtx.from)}`];
        case 'returnValue':
            return [`mov ${specialRegisterNames.functionResult}, ${getRegisterName(rtx.source)}`];
        case 'subtract':
            return [
                `mov ${getRegisterName(rtx.destination)}, ${getRegisterName(rtx.lhs)}`,
                `sub ${getRegisterName(rtx.destination)}, ${getRegisterName(rtx.rhs)}`,
            ];
        case 'add':
            if (getRegisterName(rtx.lhs) == getRegisterName(rtx.destination)) {
                return [`add ${getRegisterName(rtx.destination)}, ${getRegisterName(rtx.rhs)}`];
            }
            if (getRegisterName(rtx.rhs) == getRegisterName(rtx.destination)) {
                return [`add ${getRegisterName(rtx.destination)}, ${getRegisterName(rtx.lhs)}`];
            }
            return [
                `mov ${getRegisterName(rtx.destination)}, ${getRegisterName(rtx.lhs)}`,
                `add ${getRegisterName(rtx.destination)}, ${getRegisterName(rtx.rhs)}`,
            ];
        case 'multiply':
            return [
                `mov rax, ${getRegisterName(rtx.lhs)}`, // mul does rax * arg
                `mul ${getRegisterName(rtx.rhs)}`,
                `mov ${getRegisterName(rtx.destination)}, rax`, // mul puts result in rax:rdx
            ];
        case 'increment':
            return [`inc ${getRegisterName(rtx.register)};`];
        case 'addImmediate':
            return [`add ${getRegisterName(rtx.register)}, ${rtx.amount}`];
        case 'gotoIfEqual':
            return [`cmp ${getRegisterName(rtx.lhs)}, ${getRegisterName(rtx.rhs)}`, `je ${rtx.label}`];
        case 'gotoIfNotEqual':
            return [`cmp ${getRegisterName(rtx.lhs)}, ${getRegisterName(rtx.rhs)}`, `jne ${rtx.label}`];
        case 'gotoIfZero':
            return [`cmp ${getRegisterName(rtx.register)}, 0`, `jz ${rtx.label}`];
        case 'gotoIfGreater':
            return [`cmp ${getRegisterName(rtx.lhs)}, ${getRegisterName(rtx.rhs)}`, `jg ${rtx.label}`];
        case 'goto':
            return [`jmp ${rtx.label}`];
        case 'label':
            return [`${rtx.name}:`];
        case 'functionLabel':
            return [`${rtx.name}:`];
        case 'storeGlobal':
            return [`mov [rel ${getRegisterName(rtx.to)}], ${getRegisterName(rtx.from)}`];
        case 'loadGlobal':
            return [`mov ${getRegisterName(rtx.to)}, [rel ${rtx.from}]`];
        case 'loadMemory':
            return [`mov ${getRegisterName(rtx.to)}, [${getRegisterName(rtx.from)}+${rtx.offset}]`];
        case 'storeMemory':
            return [`mov [${getRegisterName(rtx.address)}+${rtx.offset}], ${getRegisterName(rtx.from)}`];
        case 'storeZeroToMemory':
            return [`mov byte [${getRegisterName(rtx.address)}+${rtx.offset}], 0`];
        case 'storeMemoryByte':
            return [`mov byte [${getRegisterName(rtx.address)}], ${getRegisterName(rtx.contents)}b`];
        case 'loadMemoryByte':
            return [`movsx ${getRegisterName(rtx.to)}, byte [${getRegisterName(rtx.address)}]`];
        case 'loadSymbolAddress':
            return [`lea ${getRegisterName(rtx.to)}, [rel ${rtx.symbolName}]`];
        case 'callByRegister':
            return [`call ${getRegisterName(rtx.function)}`];
        case 'callByName':
            return [`call ${rtx.function}`];
        case 'returnToCaller':
            return [`ret`];
        case 'syscall':
            // TOOD: DRY with syscall impl in mips (note: unlike mips, we don't need to save/restore syscall
            // TODO: find a way to make this less opaque to register allocation so less spilling is necessary
            if (rtx.arguments.length > 6) throw debug('x64 only supports 2 syscall args');
            const syscallArgRegisters = ['rdi', 'rsi', 'rdx', 'r10', 'r8', 'r9'];
            const syscallSelectAndResultRegister = 'rax';
            const syscallNumbers = {
                print: 0x02000004,
                sbrk: 0x02000045,
                exit: 0x02000001,
                mmap: 0x020000c5,
            };
            const registersToSave: string[] = [];
            if (rtx.destination && getRegisterName(rtx.destination) != syscallSelectAndResultRegister) {
                registersToSave.push(syscallSelectAndResultRegister);
            }
            rtx.arguments.forEach((_, index) => {
                const argRegister = syscallArgRegisters[index];
                if (rtx.destination && getRegisterName(rtx.destination) == argRegister) {
                    return;
                }
                registersToSave.push(argRegister);
            });
            const result = [
                ...registersToSave.map(r => `push ${r}`),
                ...rtx.arguments.map(
                    (arg, index) =>
                        typeof arg == 'number'
                            ? `mov ${syscallArgRegisters[index]}, ${arg}`
                            : `mov ${syscallArgRegisters[index]}, ${getRegisterName(arg)}`
                ),
                `mov ${syscallSelectAndResultRegister}, ${syscallNumbers[rtx.name]}`,
                'syscall',
                ...(rtx.destination
                    ? [`mov ${getRegisterName(rtx.destination)}, ${syscallSelectAndResultRegister}`]
                    : []),
                ...registersToSave.reverse().map(r => `pop ${r}`),
            ];
            return result;
        case 'push':
            return [`push ${getRegisterName(rtx.register)}`];
        case 'pop':
            return [`pop ${getRegisterName(rtx.register)}`];
        default:
            throw debug(`${(rtx as any).kind} unhandled in registerTransferExpressionToX64`);
    }
};

const registerTransferExpressionToX64 = (rtx: RegisterTransferLanguageExpression): string[] => {
    if (typeof rtx == 'string') return [rtx];
    return registerTransferExpressionToX64WithoutComment(rtx).map(asm => `${asm}; ${rtx.why}`);
};

const bytesInWord = 8;

const runtimeFunctions: RegisterTransferLanguageFunction[] = [
    length,
    printWithWriteRuntimeFunction,
    stringEqualityRuntimeFunction,
    stringCopy,
    mallocWithMmap,
    myFreeRuntimeFunction,
    stringConcatenateRuntimeFunction,
    verifyNoLeaks,
].map(f => f(bytesInWord, firstRegister, nextTemporary, [], []));

// TODO: degeneralize this (allowing removal of several RTL instructions)
const rtlFunctionToX64 = ({ name, instructions, numRegistersToSave }: RegisterTransferLanguageFunction): string => {
    const fullRtl = [
        { kind: 'functionLabel', name, why: 'Function entry point' },
        ...saveRegistersCode(firstRegister, nextTemporary, numRegistersToSave),
        ...instructions,
        ...restoreRegistersCode(firstRegister, nextTemporary, numRegistersToSave),
        { kind: 'returnToCaller', why: 'Done' },
    ];
    return join(['', '', ...flatten(fullRtl.map(registerTransferExpressionToX64))], '\n');
};

const stringLiteralDeclaration = (literal: StringLiteralData) =>
    `${stringLiteralName(literal)}: db "${literal.value}", 0;`;

const toExectuable = ({ functions, program, globalDeclarations, stringLiterals }: BackendInputs) => {
    let x64Functions: RegisterTransferLanguageExpression[][] = functions.map(f =>
        constructFunction(f, globalDeclarations, stringLiterals, firstRegister, nextTemporary, [], [], makeLabel)
    );
    const { registerAssignment, firstTemporary } = assignX64Registers(program.variables);

    let x64Program = flatten(
        program.statements.map(statement => {
            const compiledProgram = astToRegisterTransferLanguage(
                {
                    ast: statement,
                    registerAssignment,
                    destination: {
                        type: 'register',
                        destination: '$a0',
                    },
                    currentTemporary: firstTemporary,
                    globalDeclarations,
                    stringLiterals,
                },
                nextTemporary,
                makeLabel
            );

            return [...compiledProgram.prepare, ...compiledProgram.execute, ...compiledProgram.cleanup];
        })
    );
    return `
global start

section .text
${join(flatten(flatten(x64Functions).map(registerTransferExpressionToX64)), '\n')}
${join(runtimeFunctions.map(rtlFunctionToX64), '\n')}

start:
${join(flatten(x64Program.map(registerTransferExpressionToX64)), '\n')}
    mov rdi, rax; Move function call result to syscall arg
    mov rax, 0x02000001; system call for exit
    syscall

section .data
first_block: dq 0
${join(stringLiterals.map(stringLiteralDeclaration), '\n')}
section .bss
${globalDeclarations
        .map(name => `${name.name}: resq 1`) // TODO: actual size of var instead of always resq
        .join('\n')}
${Object.keys(errors)
        .map(key => `${errors[key].name}: resd 1`) // TODO: Fix this
        .join('\n')}
`;
};

const x64toBinary = async x64Path => {
    const linkerInputPath = await tmpFile({ postfix: '.o' });
    const exePath = await tmpFile({ postfix: '.out' });
    await exec(`nasm -fmacho64 -o ${linkerInputPath.path} ${x64Path}`);
    await exec(`ld -o ${exePath.path} ${linkerInputPath.path}`);
    return exePath;
};

export default {
    name: 'x64',
    toExectuable,
    execute: async path => execAndGetResult((await x64toBinary(path)).path),
    runtimeFunctions,
    debug: async path => {
        console.log(`lldb ${(await x64toBinary(path)).path}`);
        console.log(`break set -n start`);
        console.log(`run`);
        execSync('sleep 10000000');
    },
};
