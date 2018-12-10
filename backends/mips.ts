import { stat } from 'fs-extra';
import { exec } from 'child-process-promise';
import { errors } from '../runtime-strings.js';
import flatten from '../util/list/flatten.js';
import { BackendInputs, ExecutionResult, Function, StringLiteralData, Backend } from '../api.js';
import * as Ast from '../ast.js';
import debug from '../util/debug.js';
import { Register } from '../register.js';
import join from '../util/join.js';
import {
    RegisterAssignment,
    stringLiteralName,
    saveRegistersCode,
    restoreRegistersCode,
    RegisterDescription,
    getRegisterFromAssignment,
    rtlToTarget,
} from '../backend-utils.js';
import {
    astToThreeAddressCode,
    ThreeAddressStatement,
    TargetThreeAddressStatement,
    GlobalInfo,
    makeTargetProgram,
    TargetInfo,
    ThreeAddressProgram,
} from '../threeAddressCode/generator.js';
import { mallocWithSbrk, printWithPrintRuntimeFunction } from '../threeAddressCode/runtime.js';
import { builtinFunctions, Type, TypeDeclaration, typeSize } from '../types.js';

type MipsRegister =
    // s
    | '$s0'
    | '$s1'
    | '$s2'
    | '$s3'
    // a
    | '$a0'
    | '$a1'
    // t
    | '$t1'
    | '$t2'
    | '$t3'
    | '$t4'
    | '$t5'
    | '$t6'
    | '$t7'
    | '$t8'
    | '$t9'
    // v
    | '$v0'
    // ra
    | '$ra';

const mipsRegisterTypes: RegisterDescription<MipsRegister> = {
    generalPurpose: ['$t1', '$t2', '$t3', '$t4', '$t5', '$t6', '$t7', '$t8', '$t9'],
    functionArgument: ['$s0', '$s1', '$s2'],
    functionResult: '$a0',
    syscallArgument: ['$a0', '$a1'],
    syscallSelectAndResult: '$v0',
};

const syscallNumbers = {
    printInt: 1,
    print: 4,
    sbrk: 9,
    // mmap: 0, // There is no mmap. Should be unused on mips.
    exit: 10,
};

const bytesInWord = 4;

const threeAddressCodeToMipsWithoutComment = (tas: TargetThreeAddressStatement<MipsRegister>): string[] => {
    switch (tas.kind) {
        case 'comment':
            return [''];
        case 'syscall':
            return ['syscall'];
        case 'move':
            return [`move ${tas.to}, ${tas.from}`];
        case 'loadImmediate':
            return [`li ${tas.destination}, ${tas.value}`];
        case 'multiply':
            return [`mult ${tas.lhs}, ${tas.rhs}`, `mflo ${tas.destination}`];
        case 'addImmediate':
            return [`addiu ${tas.register}, ${tas.amount}`];
        case 'add':
            return [`add ${tas.destination}, ${tas.lhs}, ${tas.rhs}`];
        case 'subtract':
            return [`sub ${tas.destination}, ${tas.lhs}, ${tas.rhs}`];
        case 'increment':
            return [`addiu ${tas.register}, ${tas.register}, 1`];
        case 'label':
            return [`L${tas.name}:`];
        case 'functionLabel':
            return [`${tas.name}:`];
        case 'goto':
            return [`b L${tas.label}`];
        case 'gotoIfEqual':
            return [`beq ${tas.lhs}, ${tas.rhs}, L${tas.label}`];
        case 'gotoIfNotEqual':
            return [`bne ${tas.lhs}, ${tas.rhs}, L${tas.label}`];
        case 'gotoIfZero':
            return [`beq ${tas.register}, 0, L${tas.label}`];
        case 'gotoIfGreater':
            return [`bgt ${tas.lhs}, ${tas.rhs}, L${tas.label}`];
        case 'loadSymbolAddress':
            return [`la ${tas.to}, ${tas.symbolName}`];
        case 'loadGlobal':
            return [`lw ${tas.to}, ${tas.from}`];
        case 'storeGlobal':
            return [`sw ${tas.from}, ${tas.to}`];
        case 'loadMemory':
            return [`lw ${tas.to}, ${tas.offset}(${tas.from})`];
        case 'loadMemoryByte':
            return [`lb ${tas.to}, (${tas.address})`];
        case 'storeMemory':
            return [`sw ${tas.from}, ${tas.offset}(${tas.address})`];
        case 'storeZeroToMemory':
            return [`sw $0, ${tas.offset}(${tas.address})`];
        case 'storeMemoryByte':
            return [`sb ${tas.contents}, (${tas.address})`];
        case 'callByRegister':
            return [`jal ${tas.function}`];
        case 'callByName':
            return [`jal ${tas.function}`];
        case 'returnToCaller':
            return [`jr $ra`];
        case 'push':
            return [`sw ${tas.register}, ($sp)`, `addiu, $sp, $sp, -4`];
        case 'pop':
            return [`addiu $sp, $sp, 4`, `lw ${tas.register}, ($sp)`];
        case 'loadStackOffset':
            return [`move ${tas.register}, $sp`, `addiu ${tas.register}, ${tas.offset}`];
        case 'stackStore':
            return [`sw ${tas.register}, ${tas.offset * bytesInWord}($sp)`];
        case 'stackLoad':
            if (Number.isNaN(tas.offset * bytesInWord)) throw debug('nan!');
            return [`lw ${tas.register}, ${tas.offset * bytesInWord}($sp)`];
        default:
            throw debug(`${(tas as any).kind} unhandled in threeAddressCodeToMipsWithoutComment`);
    }
};

const threeAddressCodeToMips = (tas: TargetThreeAddressStatement<MipsRegister>): string[] =>
    threeAddressCodeToMipsWithoutComment(tas).map(asm => `${asm} # ${tas.why}`);

const stringLiteralDeclaration = (literal: StringLiteralData) =>
    `${stringLiteralName(literal)}: .asciiz "${literal.value}"`;

const globalDeclaration = (name: string, bytes: number): string => `${name}: .space ${bytes}`;

const mipsTarget: TargetInfo = {
    alignment: 4,
    bytesInWord: 4,
    // Cleanup code for mips prints the "exit code" because thats the best way to communicate that through spim.
    cleanupCode: [
        {
            kind: 'syscall',
            name: 'printInt',
            arguments: ['functionResult'],
            destination: undefined,
            why: 'print "exit code" and exit',
        },
        {
            kind: 'syscall',
            name: 'exit',
            arguments: ['functionResult'],
            destination: undefined,
            why: 'Whole program is done',
        },
    ],
    mallocImpl: mallocWithSbrk(bytesInWord),
    printImpl: printWithPrintRuntimeFunction(bytesInWord),
};

const tacToExecutable = ({ globals, functions, main, stringLiterals }: ThreeAddressProgram) => {
    if (!main) throw debug('need a main');
    return `
.data
${Object.values(globals)
        .map(({ mangledName, bytes }) => globalDeclaration(mangledName, bytes))
        .join('\n')}
${stringLiterals.map(stringLiteralDeclaration).join('\n')}
${Object.keys(errors)
        .map(key => `${errors[key].name}: .asciiz "${errors[key].value}"`)
        .join('\n')}

# First block pointer. Block: size, next, free
first_block: .word 0

.text
${join(
        functions.map(
            f =>
                f.name +
                ': # Funtion entry\n' +
                rtlToTarget({
                    threeAddressFunction: f,
                    makePrologue: assignment => [
                        { kind: 'push', register: '$ra', why: 'Always save return address' } as any,
                        ...saveRegistersCode<MipsRegister>(assignment),
                    ],
                    makeEpilogue: assignment => [
                        ...restoreRegistersCode<MipsRegister>(assignment),
                        { kind: 'pop', register: '$ra', why: 'Always restore return address' } as any,
                        { kind: 'returnToCaller', why: 'Done' } as any,
                    ],
                    registers: mipsRegisterTypes,
                    syscallNumbers,
                    instructionTranslator: threeAddressCodeToMips,
                })
        ),
        '\n\n\n'
    )}

main:
${rtlToTarget({
        threeAddressFunction: { name: 'unused', instructions: main, spills: 0 },
        makePrologue: () => [],
        makeEpilogue: () => [],
        registers: mipsRegisterTypes,
        syscallNumbers,
        instructionTranslator: threeAddressCodeToMips,
    })}`;
};
const mplToExectuable = (inputs: BackendInputs) =>
    tacToExecutable(makeTargetProgram({ backendInputs: inputs, targetInfo: mipsTarget }));

const execute = async (path: string): Promise<ExecutionResult> => {
    // This string is always printed with spim starts. Strip it from stdout. TODO: Look in to MARS, maybe it doesn't do this?
    const exceptionsLoadedPreamble = 'Loaded: /usr/local/Cellar/spim/9.1.17/share/exceptions.s\n';
    try {
        const result = await exec(`spim -file ${path}`);
        if (result.stderr !== '') {
            return { error: `Spim error: ${result.stderr}` };
        }
        const trimmedStdout = result.stdout.slice(exceptionsLoadedPreamble.length);
        const lines = trimmedStdout.split('\n');
        const mipsExitCode = parseInt(lines[lines.length - 1].match(/[0-9]*$/)[0], 10);
        return {
            exitCode: mipsExitCode,
            stdout: trimmedStdout.slice(0, trimmedStdout.length - mipsExitCode.toString().length),
        };
    } catch (e) {
        return {
            error: `Exception: ${e.message}`,
        };
    }
};

const mipsBackend: Backend = {
    name: 'mips',
    mplToExectuable,
    tacToExecutable: { targetInfo: mipsTarget, compile: tacToExecutable },
    execute,
    debug: path => exec(`${__dirname}/../../QtSpim.app/Contents/MacOS/QtSpim ${path}`),
    binSize: async path => (await stat(path)).size,
};

export default mipsBackend;
