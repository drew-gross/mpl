import { programToString } from '../threeAddressCode/programToString.js';
import writeTempFile from '../util/writeTempFile.js';
import { exec } from 'child-process-promise';
import { errors } from '../runtime-strings.js';
import flatten from '../util/list/flatten.js';
import * as Ast from '../ast.js';
import debug from '../util/debug.js';
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
import { Register } from '../register.js';
import {
    astToThreeAddressCode,
    TargetThreeAddressStatement,
    GlobalInfo,
    makeTargetProgram,
    TargetInfo,
    ThreeAddressProgram,
} from '../threeAddressCode/generator.js';
import { Statement } from '../threeAddressCode/statement.js';
import { mallocWithMmap, printWithWriteRuntimeFunction, readIntThroughSyscall } from '../threeAddressCode/runtime.js';
import {
    ExecutionResult,
    VariableDeclaration,
    FrontendOutput,
    StringLiteralData,
    Backend,
    CompilationResult,
} from '../api.js';
import { file as tmpFile } from 'tmp-promise';
import execAndGetResult from '../util/execAndGetResult.js';
import { execSync } from 'child_process';

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
    // printInt: XXX, // Should be unused on x64
    print: 0x02000004,
    sbrk: 0x02000045,
    exit: 0x02000001,
    mmap: 0x020000c5,
    read: 0x02000003,
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
        case 'returnToCaller':
            return [`ret`];
        case 'syscall':
            return ['syscall'];
        case 'push':
            return [`push ${tas.register}`];
        case 'pop':
            return [`pop ${tas.register}`];
        case 'loadStackOffset':
            return [`mov ${tas.register}, rsp`, `add ${tas.register}, ${tas.offset}`];
        case 'stackLoad':
            // TODO: Be consistent about where bytes in word gets multiplied
            return [`mov ${tas.register}, [rsp+${tas.offset * bytesInWord}]`];
        case 'stackStore':
            // TODO: Be consistent about where bytes in word gets multiplied
            return [`mov [rsp+${tas.offset * bytesInWord}], ${tas.register}`];
        default:
            throw debug(`${(tas as any).kind} unhandled in threeAddressCodeToX64WithoutComment`);
    }
};

const threeAddressCodeToX64 = (tas: TargetThreeAddressStatement<X64Register>): string[] =>
    threeAddressCodeToX64WithoutComment(tas).map(asm => `${asm}; ${tas.why}`);

const bytesInWord = 8;

const stringLiteralDeclaration = (literal: StringLiteralData) =>
    `${stringLiteralName(literal)}: db "${literal.value}", 0;`;

const x64Target: TargetInfo = {
    bytesInWord,
    // Cleanup for x64 just calls exit syscall with the whole program result as the exit code
    cleanupCode: [
        {
            kind: 'syscallWithoutResult',
            name: 'exit',
            arguments: ['result'],
            why: 'Whole program is done',
        },
    ],
    mallocImpl: mallocWithMmap(bytesInWord),
    readIntImpl: readIntThroughSyscall(bytesInWord),
    printImpl: printWithWriteRuntimeFunction(bytesInWord),
};

const registersClobberedBySyscall: X64Register[] = ['r11'];

const tacToExecutable = ({ globals, functions, main, stringLiterals }: ThreeAddressProgram) => {
    if (!main) throw debug('need an entry point');
    return `
global start

section .text
${join(
    functions.map(
        f =>
            f.name +
            ': ;Function entry\n' +
            rtlToTarget({
                threeAddressFunction: f,
                makePrologue: assignment => saveRegistersCode<X64Register>(assignment),
                makeEpilogue: assignment => [
                    ...restoreRegistersCode<X64Register>(assignment),
                    { kind: 'returnToCaller' as 'returnToCaller', why: 'Done' },
                ],
                registers: x64RegisterTypes,
                syscallNumbers,
                instructionTranslator: threeAddressCodeToX64,
                registersClobberedBySyscall,
            })
    ),
    '\n\n\n'
)}

start:
${rtlToTarget({
    threeAddressFunction: { instructions: main, arguments: [], name: 'unused', spills: 0 },
    makePrologue: () => [],
    makeEpilogue: () => [],
    registers: x64RegisterTypes,
    syscallNumbers,
    instructionTranslator: threeAddressCodeToX64,
    registersClobberedBySyscall,
})}
section .data
first_block: dq 0
${join(stringLiterals.map(stringLiteralDeclaration), '\n')}
section .bss
${Object.values(globals)
    .map(({ mangledName, bytes }) => `${mangledName}: resq ${bytes / bytesInWord}`)
    .join('\n')}
${Object.keys(errors)
    .map(key => `${errors[key].name}: db "${errors[key].value}", 0`)
    .join('\n')}`;
};

const compile = async (inputs: FrontendOutput): Promise<CompilationResult | { error: string }> =>
    compileTac(makeTargetProgram({ backendInputs: inputs, targetInfo: x64Target }));

const compileTac = async (tac: ThreeAddressProgram): Promise<CompilationResult | { error: string }> => {
    const threeAddressString = programToString(tac);
    const threeAddressCodeFile = await writeTempFile(threeAddressString, '.txt');

    const x64String = tacToExecutable(tac);
    const sourceFile = await writeTempFile(x64String, '.x64');

    const linkerInputPath = await tmpFile({ postfix: '.o' });

    const binaryFile = await tmpFile({ postfix: '.out' });
    try {
        await exec(`nasm -fmacho64 -o ${linkerInputPath.path} ${sourceFile.path}`);
        // TODO: Cross compiling or something? IDK. Dependency on system linker sucks.
        await exec(`ld ${linkerInputPath.path} -o ${binaryFile.path} -macosx_version_min 10.6 -lSystem`);
        return {
            sourceFile,
            binaryFile,
            threeAddressCodeFile,
            debugInstructions: `lldb ${binaryFile.path}; break set -n start; run`,
        };
    } catch (e) {
        return { error: `Exception: ${e.message}` };
    }
};

const execute = async (exePath: string, stdinPath: string): Promise<ExecutionResult> =>
    execAndGetResult(`${exePath} < ${stdinPath}`);

const x64Backend: Backend = { name: 'x64', compile, compileTac, execute, targetInfo: x64Target };
export default x64Backend;
