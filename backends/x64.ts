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
} from './threeAddressCodeRuntime.js';
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
    RegisterDescription,
} from '../backend-utils.js';
import { Register } from '../register.js';
import {
    astToThreeAddressCode,
    constructFunction,
    ThreeAddressStatement,
    ThreeAddressFunction,
    TargetThreeAddressStatement,
    threeAddressCodeToTarget,
} from './threeAddressCode.js';
import flatten from '../util/list/flatten.js';
import { VariableDeclaration, BackendInputs, StringLiteralData } from '../api.js';
import { exec } from 'child-process-promise';
import { file as tmpFile } from 'tmp-promise';
import execAndGetResult from '../util/execAndGetResult.js';
import { execSync } from 'child_process';
import idAppender from '../util/idAppender.js';
import { assignRegisters } from '../controlFlowGraph.js';

const generalPurposeRegisters = ['r11', 'r12', 'r13', 'r14', 'r15', 'rdi', 'rsi', 'rbx'];

type X64Register =
    // function args
    | 'r8'
    | 'r9'
    | 'r10'
    // function result
    | 'rax'
    // general purpose
    | 'r11'
    | 'r12'
    | 'r13'
    | 'r14'
    | 'r15'
    | 'rdi'
    | 'rsi'
    | 'rbx'
    // Syscall arg or other non-general-purpose
    | 'rdx';

const x64RegisterTypes: RegisterDescription<X64Register> = {
    generalPurpose: ['r11', 'r12', 'r13', 'r14', 'r15', 'rdi', 'rsi', 'rbx'],
    functionArgument: ['r8', 'r9', 'r10'],
    functionResult: 'rax',
    syscallArgument: ['rdi', 'rsi', 'rdx', 'r10', 'r8', 'r9'],
    syscallSelectAndResult: 'rax',
};

const syscallNumbers = {
    // printInt: 0, // Should be unused on x64
    print: 0x02000004,
    sbrk: 0x02000045,
    exit: 0x02000001,
    mmap: 0x020000c5,
};

const getX64Register = (r: Register): X64Register => {
    if (typeof r == 'string') {
        switch (r) {
            case 'functionArgument1':
                return x64RegisterTypes.functionArgument[0];
            case 'functionArgument2':
                return x64RegisterTypes.functionArgument[1];
            case 'functionArgument3':
                return x64RegisterTypes.functionArgument[2];
            case 'functionResult':
                return x64RegisterTypes.functionResult;
        }
    } else {
        return r.name as X64Register;
    }
    throw debug('should not get here');
};

const threeAddressCodeToX64WithoutComment = (tas: TargetThreeAddressStatement<X64Register>): string[] => {
    switch (tas.kind) {
        case 'comment':
            return [''];
        case 'loadImmediate':
            return [`mov ${tas.destination}, ${tas.value}`];
        case 'move':
            return [`mov ${tas.to}, ${tas.from}`];
        case 'subtract':
            return [`mov ${tas.destination}, ${tas.lhs}`, `sub ${tas.destination}, ${tas.rhs}`];
        case 'add':
            if (tas.lhs == tas.destination) {
                return [`add ${tas.destination}, ${tas.rhs}`];
            }
            if (tas.rhs == tas.destination) {
                return [`add ${tas.destination}, ${tas.lhs}`];
            }
            return [`mov ${tas.destination}, ${tas.lhs}`, `add ${tas.destination}, ${tas.rhs}`];
        case 'multiply':
            return [
                `mov rax, ${tas.lhs}`, // mul does rax * arg
                `mul ${tas.rhs}`,
                `mov ${tas.destination}, rax`, // mul puts result in rax:rdx
            ];
        case 'increment':
            return [`inc ${tas.register};`];
        case 'addImmediate':
            return [`add ${tas.register}, ${tas.amount}`];
        case 'gotoIfEqual':
            return [`cmp ${tas.lhs}, ${tas.rhs}`, `je ${tas.label}`];
        case 'gotoIfNotEqual':
            return [`cmp ${tas.lhs}, ${tas.rhs}`, `jne ${tas.label}`];
        case 'gotoIfZero':
            return [`cmp ${tas.register}, 0`, `jz ${tas.label}`];
        case 'gotoIfGreater':
            return [`cmp ${tas.lhs}, ${tas.rhs}`, `jg ${tas.label}`];
        case 'goto':
            return [`jmp ${tas.label}`];
        case 'label':
            return [`${tas.name}:`];
        case 'functionLabel':
            return [`${tas.name}:`];
        case 'storeGlobal':
            return [`mov [rel ${tas.to}], ${tas.from}`];
        case 'loadGlobal':
            return [`mov ${tas.to}, [rel ${tas.from}]`];
        case 'loadMemory':
            return [`mov ${tas.to}, [${tas.from}+${tas.offset}]`];
        case 'storeMemory':
            return [`mov [${tas.address}+${tas.offset}], ${tas.from}`];
        case 'storeZeroToMemory':
            return [`mov byte [${tas.address}+${tas.offset}], 0`];
        case 'storeMemoryByte':
            return [`mov byte [${tas.address}], ${tas.contents}b`];
        case 'loadMemoryByte':
            return [`movsx ${tas.to}, byte [${tas.address}]`];
        case 'loadSymbolAddress':
            return [`lea ${tas.to}, [rel ${tas.symbolName}]`];
        case 'callByRegister':
            return [`call ${tas.function}`];
        case 'callByName':
            return [`call ${tas.function}`];
        case 'returnToCaller':
            return [`ret`];
        case 'syscall':
            return ['syscall'];
        case 'push':
            return [`push ${tas.register}`];
        case 'pop':
            return [`pop ${tas.register}`];
        default:
            throw debug(`${(tas as any).kind} unhandled in threeAddressCodeToX64WithoutComment`);
    }
};

const threeAddressCodeToX64 = (tas: TargetThreeAddressStatement<X64Register>): string[] =>
    threeAddressCodeToX64WithoutComment(tas).map(asm => `${asm}; ${tas.why}`);

const bytesInWord = 8;

const runtimeFunctions: ThreeAddressFunction[] = [
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
const rtlFunctionToX64 = ({ name, instructions, numRegistersToSave, isMain }: ThreeAddressFunction): string => {
    const statements: TargetThreeAddressStatement<X64Register>[] = flatten(
        instructions.map(instruction =>
            threeAddressCodeToTarget(instruction, syscallNumbers, x64RegisterTypes, getX64Register)
        )
    );
    const fullRtl: TargetThreeAddressStatement<X64Register>[] = [
        { kind: 'functionLabel', name, why: 'Function entry point' },
        ...(isMain
            ? []
            : saveRegistersCode<X64Register>(firstRegister, nextTemporary, getX64Register, numRegistersToSave)),
        ...statements,
        ...(isMain
            ? []
            : restoreRegistersCode<X64Register>(firstRegister, nextTemporary, getX64Register, numRegistersToSave)),
        ...(isMain ? [] : [{ kind: 'returnToCaller' as 'returnToCaller', why: 'Done' }]),
    ];
    return join(flatten(fullRtl.map(threeAddressCodeToX64)), '\n');
};

const stringLiteralDeclaration = (literal: StringLiteralData) =>
    `${stringLiteralName(literal)}: db "${literal.value}", 0;`;

const toExectuable = ({ functions, program, globalDeclarations, stringLiterals }: BackendInputs) => {
    const temporaryNameMaker = idAppender();
    const labelMaker = idAppender();
    let x64Functions: ThreeAddressFunction[] = functions.map(f =>
        constructFunction(f, globalDeclarations, stringLiterals, labelMaker)
    );
    const mainProgramInstructions = flatten(
        program.statements.map(statement => {
            const compiledProgram = astToThreeAddressCode(
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

    let x64Program: ThreeAddressFunction = {
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
