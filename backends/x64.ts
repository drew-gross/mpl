import writeTempFile from '../util/writeTempFile';
import { exec } from 'child-process-promise';
import { errors } from '../runtime-strings';
import debug from '../util/debug';
import join from '../util/join';
import {
    stringLiteralName,
    preceedingWhitespace,
    makeExecutable,
    executableToString,
} from '../backend-utils';
import { makeTargetProgram } from '../threeAddressCode/generator';
import { Statement } from '../targetCode/Statement';
import { TargetInfo, RegisterAgnosticTargetInfo } from '../TargetInfo';
import { Program, toString } from '../threeAddressCode/Program';
import {
    mallocWithMmap,
    printWithWriteRuntimeFunction,
    readIntThroughSyscall,
} from '../threeAddressCode/runtime';
import {
    ExecutionResult,
    FrontendOutput,
    StringLiteralData,
    Backend,
    CompilationResult,
} from '../api';
import { file as tmpFile } from 'tmp-promise';
import execAndGetResult from '../util/execAndGetResult';

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

const threeAddressCodeToX64WithoutComment = (tas: Statement<X64Register>): string[] => {
    switch (tas.kind) {
        case 'comment':
            return [''];
        case 'loadImmediate':
            return [`mov ${tas.destination}, ${tas.value}`];
        case 'move':
            // TODO: an actual framework for optimizations, with e.g. tracking. Also unify with backends
            if (tas.to != tas.from) {
                return [`mov ${tas.to}, ${tas.from}`];
            } else {
                return [];
            }
        case 'subtract':
            if (tas.lhs == tas.destination) {
                return [`sub ${tas.destination}, ${tas.rhs}`];
            }
            if (tas.rhs == tas.destination) {
                return [
                    `mov rax, ${tas.rhs}`, // Save rhs so we can subtract it later
                    `mov ${tas.destination}, ${tas.lhs}`,
                    `sub ${tas.destination}, rax`,
                ];
            }
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
        case 'loadMemoryByte':
            return [`movsx ${tas.to}, byte [${tas.address}]`];
        case 'loadSymbolAddress':
            return [`lea ${tas.to}, [rel ${tas.symbolName}]`];
        case 'loadMemory':
            return [`mov ${tas.to}, [${tas.from}+${tas.offset}]`];
        case 'storeMemory':
            return [`mov [${tas.address}+${tas.offset}], ${tas.from}`];
        case 'storeZeroToMemory':
            return [`mov byte [${tas.address}+${tas.offset}], 0`];
        case 'storeMemoryByte':
            return [`mov byte [${tas.address}], ${tas.contents}b`];
        case 'callByRegister':
            return [`call ${tas.function}`];
        case 'callByName':
            return [`call ${tas.function}`];
        case 'return':
            return [`ret`];
        case 'syscall':
            return ['syscall'];
        case 'push':
            return [`push ${tas.register}`];
        case 'pop':
            return [`pop ${tas.register}`];
        case 'loadStackOffset':
            return [`mov ${tas.register}, rsp`, `add ${tas.register}, -${tas.offset}`];
        case 'stackLoad':
            // TODO: Be consistent about where bytes in word gets multiplied
            return [`mov ${tas.register}, [rsp+${tas.offset * bytesInWord}]`];
        case 'stackStore':
            // TODO: Be consistent about where bytes in word gets multiplied
            return [`mov [rsp+${tas.offset * bytesInWord}], ${tas.register}`];
        case 'stackReserve':
            return [`add rsp, -${tas.words * bytesInWord}`];
        case 'stackRelease':
            return [`add rsp, ${tas.words * bytesInWord}`];
        default:
            throw debug(`${(tas as any).kind} unhandled in threeAddressCodeToX64WithoutComment`);
    }
};

const threeAddressCodeToX64 = (tas: Statement<X64Register>): string[] =>
    threeAddressCodeToX64WithoutComment(tas).map(
        asm => `${preceedingWhitespace(tas)}${asm}; ${tas.why.trim()}`
    );

const bytesInWord = 8;

const stringLiteralDeclaration = (literal: StringLiteralData) =>
    `${stringLiteralName(literal)}: db "${literal.value}", 0;`;

const x64Target: RegisterAgnosticTargetInfo = {
    bytesInWord,
    syscallNumbers: {
        // printInt: XXX, // Should be unused on x64
        print: 0x02000004,
        sbrk: 0x02000045,
        exit: 0x02000001,
        mmap: 0x020000c5,
        read: 0x02000003,
    },
    functionImpls: {
        mallocImpl: mallocWithMmap(bytesInWord),
        readIntImpl: readIntThroughSyscall(bytesInWord),
        printImpl: printWithWriteRuntimeFunction(bytesInWord),
    },
};

const x64RegisterInfo: TargetInfo<X64Register> = {
    extraSavedRegisters: [],
    callerSavedRegisters: ['unknown', 'implicit return address'],
    registersClobberedBySyscall: ['r11'],
    registers: {
        generalPurpose: ['r11', 'r12', 'r13', 'r14', 'r15', 'rdi', 'rsi', 'rbx'],
        functionArgument: ['r8', 'r9', 'r10'],
        functionResult: 'rax',
        syscallArgument: ['rdi', 'rsi', 'rdx', 'r10', 'r8', 'r9'],
        syscallSelectAndResult: 'rax',
    },
    translator: threeAddressCodeToX64,
    registerAgnosticInfo: x64Target,
};

const tacToExecutable = (tac: Program, includeCleanup: boolean) => {
    const executable = makeExecutable(
        tac,
        x64Target,
        x64RegisterInfo,
        threeAddressCodeToX64,
        includeCleanup
    );
    executable.main.name = 'start';
    return {
        target: `
global start

section .text
${executableToString(';', executable)}
section .data
first_block: dq 0
${join(tac.stringLiterals.map(stringLiteralDeclaration), '\n')}
section .bss
${Object.values(tac.globals)
    .map(({ mangledName, bytes }) => `${mangledName}: resq ${bytes / bytesInWord}`)
    .join('\n')}
${Object.keys(errors)
    .map(key => `${errors[key].name}: db "${errors[key].value}", 0`)
    .join('\n')}
`,
        tac,
    };
};

const compile = (
    inputs: FrontendOutput
): { target: string; tac: Program | undefined } | { error: string } => {
    const tac = makeTargetProgram({ backendInputs: inputs, targetInfo: x64Target });
    const target = compileTac(tac, true);
    if (typeof target != 'string') return target;
    return { target, tac };
};

const compileTac = (tac: Program, includeCleanup): string | { error: string } => {
    return tacToExecutable(tac, includeCleanup).target;
};

const finishCompilation = async (
    x64source: string,
    tac: Program | undefined
): Promise<CompilationResult | { error: string }> => {
    const threeAddressCodeFile = tac
        ? await writeTempFile(toString(tac), 'three-address-core-x64', 'txt')
        : undefined;
    const sourceFile = await writeTempFile(x64source, 'program', 'x64');

    const linkerInputPath = await tmpFile({ template: 'object-XXXXXX.o', dir: '/tmp' });

    const binaryFile = await tmpFile({ template: 'binary-XXXXXX.out', dir: '/tmp' });
    try {
        await exec(`nasm -fmacho64 -o ${linkerInputPath.path} ${sourceFile.path}`);
        // TODO: Cross compiling or something? IDK. Dependency on system linker sucks.
        await exec(
            `ld ${linkerInputPath.path} -o ${binaryFile.path} -macosx_version_min 10.6 -lSystem`
        );
        return {
            source: x64source,
            sourceFile,
            binaryFile,
            threeAddressCodeFile,
            threeAddressCode: {},
        };
    } catch (e) {
        return { error: `Exception: ${e.message}` };
    }
};

const execute = async (exePath: string, stdinPath: string): Promise<ExecutionResult> => {
    const runInstructions = `${exePath} < ${stdinPath}`;
    return {
        ...(await execAndGetResult(runInstructions)),
        executorName: 'local',
        runInstructions,
        debugInstructions: `lldb ${exePath}; break set -n start; settings set target.input-path ${stdinPath}; run; gui`,
    };
};

const x64Backend: Backend = {
    name: 'x64',
    compile,
    compileTac,
    finishCompilation,
    executors: [{ execute, name: 'local' }],
    targetInfo: x64Target,
};
export default x64Backend;
