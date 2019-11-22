import writeTempFile from '../util/writeTempFile.js';
import { errors } from '../runtime-strings.js';
import {
    FrontendOutput,
    ExecutionResult,
    StringLiteralData,
    Backend,
    CompilationResult,
} from '../api.js';
import debug from '../util/debug.js';
import execAndGetResult from '../util/execAndGetResult.js';
import { stringLiteralName, preceedingWhitespace, makeExecutable } from '../backend-utils.js';
import {
    TargetThreeAddressStatement,
    makeTargetProgram,
    TargetInfo,
    ThreeAddressProgram,
    TargetRegisterInfo,
} from '../threeAddressCode/generator.js';
import { programToString } from '../threeAddressCode/programToString.js';
import {
    mallocWithSbrk,
    printWithPrintRuntimeFunction,
    readIntDirect,
} from '../threeAddressCode/runtime.js';

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

const bytesInWord = 4;

const threeAddressCodeToMipsWithoutComment = (
    tas: TargetThreeAddressStatement<MipsRegister>
): string[] => {
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
            return [`addiu ${tas.register}, ${tas.register}, ${tas.amount}`];
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
            return [`jalr ${tas.function}`];
        case 'callByName':
            return [`jal ${tas.function}`];
        case 'return':
            return [`jr $ra`];
        case 'push':
            return [`addiu, $sp, $sp, -4`, `sw ${tas.register}, ($sp)`];
        case 'pop':
            return [`lw ${tas.register}, ($sp)`, `addiu $sp, $sp, 4`];
        case 'loadStackOffset':
            return [
                `move ${tas.register}, $sp`,
                `addiu ${tas.register}, ${tas.register}, ${-tas.offset}`,
            ];
        case 'stackStore':
            return [`sw ${tas.register}, ${tas.offset * bytesInWord}($sp)`];
        case 'stackLoad':
            if (Number.isNaN(tas.offset * bytesInWord)) throw debug('nan!');
            return [`lw ${tas.register}, ${tas.offset * bytesInWord}($sp)`];
        case 'stackReserve':
            return [`addiu $sp, $sp, ${-(tas.words * bytesInWord)}`];
        case 'stackRelease':
            return [`addiu $sp, $sp, ${tas.words * bytesInWord}`];
        default:
            throw debug(
                `${(tas as any).kind} unhandled in threeAddressCodeToMipsWithoutComment`
            );
    }
};

const threeAddressCodeToMips = (tas: TargetThreeAddressStatement<MipsRegister>): string[] =>
    threeAddressCodeToMipsWithoutComment(tas).map(
        asm => `${preceedingWhitespace(tas)}${asm} # ${tas.why.trim()}`
    ); // TODO: trim shouldn't be necessarary, the comment should just not have trailing newlines

const stringLiteralDeclaration = (literal: StringLiteralData) =>
    `${stringLiteralName(literal)}: .asciiz "${literal.value}"`;

const globalDeclaration = (name: string, bytes: number): string => `${name}: .space ${bytes}`;

const mipsTarget: TargetInfo = {
    bytesInWord: 4,
    mainName: 'main',
    syscallNumbers: {
        printInt: 1,
        readInt: 5,
        print: 4,
        sbrk: 9,
        // mmap: 0, // There is no mmap. Should be unused on mips.
        exit: 17,
    },
    mallocImpl: mallocWithSbrk(bytesInWord),
    printImpl: printWithPrintRuntimeFunction(bytesInWord),
    readIntImpl: readIntDirect(bytesInWord),
};

const mipsRegisters: TargetRegisterInfo<MipsRegister> = {
    extraSavedRegisters: ['$ra'],
    registersClobberedBySyscall: [],
    registerDescription: {
        generalPurpose: ['$t1', '$t2', '$t3', '$t4', '$t5', '$t6', '$t7', '$t8', '$t9'],
        functionArgument: ['$s0', '$s1', '$s2'],
        functionResult: '$a0',
        syscallArgument: ['$a0', '$a1'],
        syscallSelectAndResult: '$v0',
    },
    translator: threeAddressCodeToMips,
};

const tacToExecutable = (tac: ThreeAddressProgram, includeCleanup: boolean) => `
.data
${Object.values(tac.globals)
    .map(({ mangledName, bytes }) => globalDeclaration(mangledName, bytes))
    .join('\n')}
${tac.stringLiterals.map(stringLiteralDeclaration).join('\n')}
${Object.keys(errors)
    .map(key => `${errors[key].name}: .asciiz "${errors[key].value}"`)
    .join('\n')}

# First block pointer. Block: size, next, free
first_block: .word 0

.text
${makeExecutable(tac, mipsTarget, mipsRegisters, includeCleanup)}
`;

const compile = async (inputs: FrontendOutput): Promise<CompilationResult | { error: string }> =>
    compileTac(makeTargetProgram({ backendInputs: inputs, targetInfo: mipsTarget }), true);

const compileTac = async (
    tac: ThreeAddressProgram,
    includeCleanup: boolean
): Promise<CompilationResult | { error: string }> => {
    const threeAddressString = programToString(tac);
    const threeAddressCodeFile = await writeTempFile(
        threeAddressString,
        'three-address-code-mips',
        'txt'
    );

    const sourceFile = await writeTempFile(
        tacToExecutable(tac, includeCleanup),
        'program',
        'mips'
    );
    return { sourceFile, binaryFile: sourceFile, threeAddressCodeFile };
};

const spimExecutor = async (
    executablePath: string,
    stdinPath: string
): Promise<ExecutionResult> => {
    // This string is always printed with spim starts. Strip it from stdout.
    const exceptionsLoadedPreamble =
        'Loaded: /usr/local/Cellar/spim/9.1.17/share/exceptions.s\n';
    try {
        const result = await execAndGetResult(`spim -file ${executablePath} < ${stdinPath}`);
        if ('error' in result) {
            return { error: `Spim error: ${result.error}`, executorName: 'spim' };
        }
        if (result.stderr !== '') {
            return { error: `Spim error: ${result.stderr}`, executorName: 'spim' };
        }
        const trimmedStdout = result.stdout.slice(exceptionsLoadedPreamble.length);
        return {
            exitCode: result.exitCode,
            stdout: trimmedStdout,
            executorName: 'spim',
            runInstructions: `spim -file ${executablePath} < ${stdinPath}`,
            debugInstructions: `./QtSpim.app/Contents/MacOS/QtSpim ${executablePath}`,
        };
    } catch (e) {
        return { error: `Exception: ${e.message}`, executorName: 'spim' };
    }
};

const marsExecutor = async (
    executablePath: string,
    stdinPath: string
): Promise<ExecutionResult> => {
    try {
        const result = await execAndGetResult(
            `java -jar Mars4_5.jar nc ${executablePath} < ${stdinPath}`
        );
        if ('error' in result) {
            return { error: `MARS error: ${result.error}`, executorName: 'mars' };
        }
        // MARS adds an extra trailing newline that we don't expect. Remove it.
        const trimmedStdout = result.stdout.slice(0, result.stdout.length - 1);

        return {
            exitCode: result.exitCode,
            stdout: trimmedStdout,
            executorName: 'mars',
            runInstructions: `java -jar Mars4_5.jar nc ${executablePath} < ${stdinPath}`,
            debugInstructions: `java -jar Mars4_5.jar # then open ${executablePath}`,
        };
    } catch (e) {
        return { error: `Exception: ${e.message}`, executorName: 'mars' };
    }
};

const mipsBackend: Backend = {
    name: 'mips',
    compile,
    compileTac,
    targetInfo: mipsTarget,
    executors: [
        { execute: spimExecutor, name: 'spim' },
        { execute: marsExecutor, name: 'mars' },
    ],
};
export default mipsBackend;
