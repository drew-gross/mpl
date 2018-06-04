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
    RegisterAssignment,
    compileExpression,
    stringLiteralName,
    saveRegistersCode,
    restoreRegistersCode,
} from '../backend-utils.js';
import { Register } from '../register.js';
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
import idAppender from '../util/idAppender.js';
import { assignRegisters } from '../controlFlowGraph.js';

const generalPurposeRegisters = ['r11', 'r12', 'r13', 'r14', 'r15', 'rdi', 'rsi', 'rbx'];

const specialRegisterNames = {
    functionArgument1: 'r8',
    functionArgument2: 'r9',
    functionArgument3: 'r10',
    functionResult: 'rax',
};

const getRegisterName = (registerAssignment: RegisterAssignment, register: Register): string => {
    if (typeof register == 'string') {
        return specialRegisterNames[register];
    } else {
        return (registerAssignment[register.name] as any).name;
    }
};

const registerTransferExpressionToX64WithoutComment = (
    registerAssignment: RegisterAssignment,
    rtx: RegisterTransferLanguageExpression
): string[] => {
    const getReg = getRegisterName.bind(registerAssignment);
    switch (rtx.kind) {
        case 'comment':
            return [''];
        case 'loadImmediate':
            return [`mov ${getReg(rtx.destination)}, ${rtx.value}`];
        case 'move':
            return [`mov ${getReg(rtx.to)}, ${getReg(rtx.from)}`];
        case 'returnValue':
            return [`mov ${specialRegisterNames.functionResult}, ${getReg(rtx.source)}`];
        case 'subtract':
            return [
                `mov ${getReg(rtx.destination)}, ${getReg(rtx.lhs)}`,
                `sub ${getReg(rtx.destination)}, ${getReg(rtx.rhs)}`,
            ];
        case 'add':
            if (getReg(rtx.lhs) == getReg(rtx.destination)) {
                return [`add ${getReg(rtx.destination)}, ${getReg(rtx.rhs)}`];
            }
            if (getReg(rtx.rhs) == getReg(rtx.destination)) {
                return [`add ${getReg(rtx.destination)}, ${getReg(rtx.lhs)}`];
            }
            return [
                `mov ${getReg(rtx.destination)}, ${getReg(rtx.lhs)}`,
                `add ${getReg(rtx.destination)}, ${getReg(rtx.rhs)}`,
            ];
        case 'multiply':
            return [
                `mov rax, ${getReg(rtx.lhs)}`, // mul does rax * arg
                `mul ${getReg(rtx.rhs)}`,
                `mov ${getReg(rtx.destination)}, rax`, // mul puts result in rax:rdx
            ];
        case 'increment':
            return [`inc ${getReg(rtx.register)};`];
        case 'addImmediate':
            return [`add ${getReg(rtx.register)}, ${rtx.amount}`];
        case 'gotoIfEqual':
            return [`cmp ${getReg(rtx.lhs)}, ${getReg(rtx.rhs)}`, `je ${rtx.label}`];
        case 'gotoIfNotEqual':
            return [`cmp ${getReg(rtx.lhs)}, ${getReg(rtx.rhs)}`, `jne ${rtx.label}`];
        case 'gotoIfZero':
            return [`cmp ${getReg(rtx.register)}, 0`, `jz ${rtx.label}`];
        case 'gotoIfGreater':
            return [`cmp ${getReg(rtx.lhs)}, ${getReg(rtx.rhs)}`, `jg ${rtx.label}`];
        case 'goto':
            return [`jmp ${rtx.label}`];
        case 'label':
            return [`${rtx.name}:`];
        case 'functionLabel':
            return [`${rtx.name}:`];
        case 'storeGlobal':
            return [`mov [rel ${getReg(rtx.to)}], ${getReg(rtx.from)}`];
        case 'loadGlobal':
            return [`mov ${getReg(rtx.to)}, [rel ${rtx.from}]`];
        case 'loadMemory':
            return [`mov ${getReg(rtx.to)}, [${getReg(rtx.from)}+${rtx.offset}]`];
        case 'storeMemory':
            return [`mov [${getReg(rtx.address)}+${rtx.offset}], ${getReg(rtx.from)}`];
        case 'storeZeroToMemory':
            return [`mov byte [${getReg(rtx.address)}+${rtx.offset}], 0`];
        case 'storeMemoryByte':
            return [`mov byte [${getReg(rtx.address)}], ${getReg(rtx.contents)}b`];
        case 'loadMemoryByte':
            return [`movsx ${getReg(rtx.to)}, byte [${getReg(rtx.address)}]`];
        case 'loadSymbolAddress':
            return [`lea ${getReg(rtx.to)}, [rel ${rtx.symbolName}]`];
        case 'callByRegister':
            return [`call ${getReg(rtx.function)}`];
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
                // printInt: 0, // Should be unused on x64
                print: 0x02000004,
                sbrk: 0x02000045,
                exit: 0x02000001,
                mmap: 0x020000c5,
            };
            const registersToSave: string[] = [];
            if (rtx.destination && getReg(rtx.destination) != syscallSelectAndResultRegister) {
                registersToSave.push(syscallSelectAndResultRegister);
            }
            rtx.arguments.forEach((_, index) => {
                const argRegister = syscallArgRegisters[index];
                if (rtx.destination && getReg(rtx.destination) == argRegister) {
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
                            : `mov ${syscallArgRegisters[index]}, ${getReg(arg)}`
                ),
                `mov ${syscallSelectAndResultRegister}, ${syscallNumbers[rtx.name]}`,
                'syscall',
                ...(rtx.destination ? [`mov ${getReg(rtx.destination)}, ${syscallSelectAndResultRegister}`] : []),
                ...registersToSave.reverse().map(r => `pop ${r}`),
            ];
            return result;
        case 'push':
            return [`push ${getReg(rtx.register)}`];
        case 'pop':
            return [`pop ${getReg(rtx.register)}`];
        default:
            throw debug(`${(rtx as any).kind} unhandled in registerTransferExpressionToX64`);
    }
};

const registerTransferExpressionToX64 = (
    registerAssignment: RegisterAssignment,
    rtx: RegisterTransferLanguageExpression
): string[] => {
    if (typeof rtx == 'string') return [rtx];
    return registerTransferExpressionToX64WithoutComment(registerAssignment, rtx).map(asm => `${asm}; ${rtx.why}`);
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
].map(f => f(bytesInWord));

// TODO: degeneralize this (allowing removal of several RTL instructions)
const rtlFunctionToX64 = (rtlf: RegisterTransferLanguageFunction): string => {
    const registerAssignment = assignRegisters(rtlf);
    const fullRtl: RegisterTransferLanguageExpression[] = [
        { kind: 'functionLabel', name, why: 'Function entry point' },
        ...(rtlf.isMain ? [] : saveRegistersCode(registerAssignment)),
        ...rtlf.instructions,
        ...(rtlf.isMain ? [] : restoreRegistersCode(registerAssignment)),
        ...(rtlf.isMain ? [] : [{ kind: 'returnToCaller', why: 'Done' } as RegisterTransferLanguageExpression]),
    ];
    return join(flatten(fullRtl.map(e => registerTransferExpressionToX64(registerAssignment, e))), '\n');
};

const stringLiteralDeclaration = (literal: StringLiteralData) =>
    `${stringLiteralName(literal)}: db "${literal.value}", 0;`;

const toExectuable = ({ functions, program, globalDeclarations, stringLiterals }: BackendInputs) => {
    const temporaryNameMaker = idAppender();
    const labelMaker = idAppender();
    let x64Functions: RegisterTransferLanguageFunction[] = functions.map(f =>
        constructFunction(f, globalDeclarations, stringLiterals, labelMaker)
    );
    const mainProgramInstructions = flatten(
        program.statements.map(statement => {
            const compiledProgram = astToRegisterTransferLanguage({
                ast: statement,
                destination: 'functionResult',
                globalDeclarations,
                stringLiterals,
                variablesInScope: {},
                makeLabel: labelMaker,
                makeTemporary: name => ({ name: temporaryNameMaker(name) }),
            });

            return [...compiledProgram.prepare, ...compiledProgram.execute, ...compiledProgram.cleanup];
        })
    );

    let x64Program: RegisterTransferLanguageFunction = {
        name: 'start',
        isMain: true,
        instructions: [
            ...mainProgramInstructions,
            {
                kind: 'syscall',
                name: 'exit',
                arguments: ['functionResult'],
                destination: undefined,
                why: 'Whole program is done',
            },
        ],
    };
    return `
global start

section .text
${join([...runtimeFunctions, ...x64Functions, x64Program].map(rtlFunctionToX64), '\n\n\n')}
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
