import flatten from '../util/list/flatten.js';
import writeTempFile from '../util/writeTempFile.js';
import { exec } from 'child-process-promise';
import { errors } from '../runtime-strings.js';
import { FrontendOutput, ExecutionResult, StringLiteralData, Backend, CompilationResult } from '../api.js';
import debug from '../util/debug.js';
import join from '../util/join.js';
import { stringLiteralName, RegisterDescription, tacToTargetFunction, preceedingWhitespace } from '../backend-utils.js';
import {
    TargetThreeAddressStatement,
    makeTargetProgram,
    TargetInfo,
    ThreeAddressProgram,
} from '../threeAddressCode/generator.js';
import { programToString } from '../threeAddressCode/programToString.js';
import { mallocWithSbrk, printWithPrintRuntimeFunction, readIntDirect } from '../threeAddressCode/runtime.js';

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
    readInt: 5,
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
        case 'return':
            return [`jr $ra`];
        case 'push':
            return [`sw ${tas.register}, ($sp)`, `addiu, $sp, $sp, -4`];
        case 'pop':
            return [`addiu $sp, $sp, 4`, `lw ${tas.register}, ($sp)`];
        case 'loadStackOffset':
            return [`move ${tas.register}, $sp`, `addiu ${tas.register}, -${tas.offset}`];
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
    threeAddressCodeToMipsWithoutComment(tas).map(asm => `${preceedingWhitespace(tas)}${asm} # ${tas.why.trim()}`); // TODO: trim shouldn't be necessarary, the comment should just not have trailing newlines

const stringLiteralDeclaration = (literal: StringLiteralData) =>
    `${stringLiteralName(literal)}: .asciiz "${literal.value}"`;

const globalDeclaration = (name: string, bytes: number): string => `${name}: .space ${bytes}`;

const mipsTarget: TargetInfo = {
    bytesInWord: 4,
    mallocImpl: mallocWithSbrk(bytesInWord),
    printImpl: printWithPrintRuntimeFunction(bytesInWord),
    readIntImpl: readIntDirect(bytesInWord),
};

// TODO: put this in TargetInfo
const registersClobberedBySyscall: MipsRegister[] = [];

const tacToExecutable = (
    { globals, functions, main, stringLiterals }: ThreeAddressProgram,
    includeLeakCheck: boolean
) => {
    if (!main) throw debug('need a main');
    const mipsFunctions = functions.map(f =>
        tacToTargetFunction({
            threeAddressFunction: f,
            extraSavedRegisters: ['$ra'], // Save return address
            registers: mipsRegisterTypes,
            syscallNumbers,
            registersClobberedBySyscall,
            finalCleanup: [{ kind: 'return', why: 'Done' }],
            isMain: false,
        })
    );
    const mainFunction = tacToTargetFunction({
        threeAddressFunction: main,
        extraSavedRegisters: [], // No need to save registers in main
        registers: mipsRegisterTypes,
        syscallNumbers,
        registersClobberedBySyscall,
        finalCleanup: [
            // TODO: push/pop exit code is jank and should be removed.
            {
                kind: 'push',
                register: mipsRegisterTypes.functionResult,
                why: "Need to save exit code so it isn't clobbber by free_globals/verify_no_leaks",
            },
            {
                kind: 'callByName' as 'callByName',
                function: 'free_globals',
                why: 'free_globals',
            },
            ...(includeLeakCheck
                ? [{ kind: 'callByName' as 'callByName', function: 'verify_no_leaks', why: 'verify_no_leaks' }]
                : []),
            {
                kind: 'pop',
                register: mipsRegisterTypes.syscallArgument[0],
                why: 'restore exit code',
            },
            // Cleanup code for mips prints the "exit code" because thats the best way to communicate that through spim.
            {
                kind: 'loadImmediate' as 'loadImmediate',
                destination: mipsRegisterTypes.syscallSelectAndResult,
                value: syscallNumbers.printInt,
                why: 'prepare to print exit code',
            },
            { kind: 'syscall' as 'syscall', why: 'print exit code' },
            {
                kind: 'loadImmediate' as 'loadImmediate',
                destination: mipsRegisterTypes.syscallSelectAndResult,
                value: syscallNumbers.exit,
                why: 'prepare to exit',
            },
            { kind: 'syscall' as 'syscall', why: 'exit' },
        ],
        isMain: true,
    });
    const mipsFunctionStrings: string[] = mipsFunctions.map(
        ({ name, instructions }) => `
${name}:
${join(flatten(instructions.map(threeAddressCodeToMips)), '\n')}`
    );
    const mainFunctionString: string = `
${mainFunction.name}:
${join(flatten(mainFunction.instructions.map(threeAddressCodeToMips)), '\n')}
    `;
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
${join(mipsFunctionStrings, '\n')}
${mainFunctionString}`;
};

const compile = async (inputs: FrontendOutput): Promise<CompilationResult | { error: string }> =>
    compileTac(makeTargetProgram({ backendInputs: inputs, targetInfo: mipsTarget }), true);

const compileTac = async (
    tac: ThreeAddressProgram,
    includeLeakCheck: boolean
): Promise<CompilationResult | { error: string }> => {
    const threeAddressString = programToString(tac);
    const threeAddressCodeFile = await writeTempFile(threeAddressString, '.txt');

    const mipsString = tacToExecutable(tac, includeLeakCheck);
    const sourceFile = await writeTempFile(mipsString, '.mips');
    const binaryFile = sourceFile;

    return {
        sourceFile,
        binaryFile,
        threeAddressCodeFile,
        debugInstructions: `./QtSpim.app/Contents/MacOS/QtSpim ${binaryFile.path}`,
    };
};

const execute = async (executablePath: string, stdinPath: string): Promise<ExecutionResult> => {
    // This string is always printed with spim starts. Strip it from stdout. TODO: Look in to MARS, maybe it doesn't do this?
    const exceptionsLoadedPreamble = 'Loaded: /usr/local/Cellar/spim/9.1.17/share/exceptions.s\n';
    try {
        const result = await exec(`spim -file ${executablePath} < ${stdinPath}`);
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
        return { error: `Exception: ${e.message}` };
    }
};

const mipsBackend: Backend = { name: 'mips', compile, compileTac, targetInfo: mipsTarget, execute };
export default mipsBackend;
