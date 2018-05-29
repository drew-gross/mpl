import { exec } from 'child-process-promise';
import { isEqual } from 'lodash';
import flatten from '../util/list/flatten.js';
import { VariableDeclaration, BackendInputs, ExecutionResult, Function, StringLiteralData } from '../api.js';
import * as Ast from '../ast.js';
import debug from '../util/debug.js';
import { CompiledProgram, BackendOptions, compileExpression, Register, stringLiteralName } from '../backend-utils.js';
import {
    astToRegisterTransferLanguage,
    constructFunction,
    RegisterTransferLanguageExpression,
} from './registerTransferLanguage.js';
import {
    mallocWithSbrk,
    length,
    stringCopy,
    KnownRegisters,
    verifyNoLeaks,
    printWithPrintRuntimeFunction,
    stringConcatenateRuntimeFunction,
    stringEqualityRuntimeFunction,
    myFreeRuntimeFunction,
} from './registerTransferLanguageRuntime.js';
import { errors } from '../runtime-strings.js';
import { builtinFunctions } from '../frontend.js';
import join from '../util/join.js';

// 's' registers are used for the args, starting as 0. Spill recovery shall start at the last (7)
const knownRegisters: KnownRegisters = {
    argument1: { type: 'register', destination: '$s0' },
    argument2: { type: 'register', destination: '$s1' },
    argument3: { type: 'register', destination: '$s2' },
    functionResult: { type: 'register', destination: '$a0' },
    syscallArg1: { type: 'register', destination: '$a0' },
    syscallArg2: { type: 'register', destination: '$a1' },
    syscallArg3: { type: 'register', destination: 'unused' },
    syscallArg4: { type: 'register', destination: 'unused' },
    syscallArg5: { type: 'register', destination: 'unused' },
    syscallArg6: { type: 'register', destination: 'unused' },
    syscallSelect: { type: 'register', destination: '$v0' },
    syscallResult: { type: 'register', destination: '$v0' },
};

const generalPurposeRegisters = ['$t1', '$t2', '$t3', '$t4', '$t5', '$t6', '$t7', '$t8', '$t9'];

let labelId = 0;
const makeLabel = (name: string) => {
    const result = `${name}${labelId}`;
    labelId++;
    return result;
};

const registerTransferExpressionToMipsWithoutComment = (rtx: RegisterTransferLanguageExpression): string[] => {
    switch (rtx.kind) {
        case 'comment':
            return [''];
        case 'syscall':
            return ['syscall'];
        case 'move':
            if (rtx.to.type !== 'register') throw debug('todo');
            if (rtx.from.type !== 'register') throw debug('todo');
            return [`move ${rtx.to.destination}, ${rtx.from.destination}`];
        case 'loadImmediate':
            switch (rtx.destination.type) {
                case 'register':
                    return [`li ${rtx.destination.destination}, ${rtx.value}`];
                // TODO: use a register allocator
                case 'memory':
                    return [[`li $s7, ${rtx.value}`, `sw $s7, -${rtx.destination.spOffset}($sp)`].join('\n')];
                default:
                    throw debug('todo');
            }
        case 'multiply': {
            let leftRegister = (rtx.lhs as any).destination;
            let loadSpilled: any = [];
            let restoreSpilled: any = [];
            if (rtx.lhs.type == 'memory') {
                leftRegister = '$s1';
                loadSpilled.push(`lw $s1, -${rtx.lhs.spOffset}($sp)`);
            }

            let rightRegister = (rtx.rhs as any).destination;
            if (rtx.rhs.type == 'memory') {
                rightRegister = '$s2';
                loadSpilled.push(`lw $s2, -${rtx.rhs.spOffset}($sp)`);
            }

            let destinationRegister = (rtx.destination as any).destination;
            if (rtx.destination.type == 'memory') {
                destinationRegister = '$s3';
                restoreSpilled.push(`sw $s3, -${rtx.destination.spOffset}($sp)`);
            }
            if (leftRegister == '$tNaN') debug('todo');

            return [
                ...loadSpilled,
                `mult ${leftRegister}, ${rightRegister}`,
                `# Move result to final destination (assume no overflow)`,
                `mflo ${destinationRegister}`,
                ...restoreSpilled,
            ];
        }
        case 'addImmediate':
            if (rtx.register.type !== 'register') throw debug('need a registe');
            return [`addiu ${rtx.register.destination}, ${rtx.amount}`];
        case 'add':
            if (rtx.lhs.type !== 'register') throw debug('todo');
            if (rtx.rhs.type !== 'register') throw debug('todo');
            if (rtx.destination.type !== 'register') throw debug('todo');
            return [`add ${rtx.destination.destination}, ${rtx.lhs.destination}, ${rtx.rhs.destination}`];
        case 'returnValue':
            if (rtx.source.type !== 'register') throw debug('todo');
            return [`move ${knownRegisters.functionResult.destination}, ${rtx.source.destination}`];
        case 'subtract':
            if (rtx.lhs.type !== 'register') throw debug('todo');
            if (rtx.rhs.type !== 'register') throw debug('todo');
            if (rtx.destination.type !== 'register') throw debug('todo');
            return [`sub ${rtx.destination.destination}, ${rtx.lhs.destination}, ${rtx.rhs.destination}`];
        case 'increment':
            if (rtx.register.type !== 'register') throw debug('need a registe');
            return [`addiu ${rtx.register.destination}, ${rtx.register.destination}, 1`];
        case 'label':
            return [`L${rtx.name}:`];
        case 'functionLabel':
            return [`${rtx.name}:`];
        case 'goto':
            return [`b L${rtx.label}`];
        case 'gotoIfEqual':
            if (rtx.lhs.type !== 'register' || rtx.rhs.type !== 'register') throw debug('todo');
            return [`beq ${rtx.lhs.destination}, ${rtx.rhs.destination}, L${rtx.label}`];
        case 'gotoIfNotEqual':
            if (rtx.lhs.type !== 'register') throw debug('todo');
            if (rtx.rhs.type !== 'register') throw debug('todo');
            return [`bne ${rtx.lhs.destination}, ${rtx.rhs.destination}, L${rtx.label}`];
        case 'gotoIfZero':
            if (rtx.register.type !== 'register') throw debug('need a registe');
            return [`beq ${rtx.register.destination}, 0, L${rtx.label}`];
        case 'gotoIfGreater':
            if (rtx.lhs.type !== 'register') throw debug('todo');
            if (rtx.rhs.type !== 'register') throw debug('todo');
            return [`bgt ${rtx.lhs.destination}, ${rtx.rhs.destination}, L${rtx.label}`];
        case 'loadSymbolAddress':
            if (rtx.to.type !== 'register') throw debug('todo');
            return [`la ${rtx.to.destination}, ${rtx.symbolName}`];
        case 'loadGlobal':
            if (rtx.to.type !== 'register') throw debug('todo');
            return [`lw ${rtx.to.destination}, ${rtx.from}`];
        case 'storeGlobal':
            if (rtx.to.type !== 'register') throw debug('todo');
            if (rtx.from.type !== 'register') throw debug('todo');
            return [`sw ${rtx.from.destination}, ${rtx.to.destination}`];
        case 'loadMemory':
            if (rtx.to.type !== 'register') throw debug('todo');
            if (rtx.from.type !== 'register') throw debug('todo');
            return [`lw ${rtx.to.destination}, ${rtx.offset}(${rtx.from.destination})`];
        case 'loadMemoryByte':
            if (rtx.to.type !== 'register') throw debug('todo');
            if (rtx.address.type !== 'register') throw debug('todo');
            return [`lb ${rtx.to.destination}, (${rtx.address.destination})`];
        case 'storeMemory':
            if (rtx.address.type !== 'register') throw debug('todo');
            if (rtx.from.type !== 'register') throw debug('todo');
            return [`sw ${rtx.from.destination}, ${rtx.offset}(${rtx.address.destination})`];
        case 'storeZeroToMemory':
            if (rtx.address.type !== 'register') throw debug('todo');
            return [`sw $0, ${rtx.offset}(${rtx.address.destination})`];
        case 'storeMemoryByte':
            if (rtx.contents.type !== 'register') throw debug('Need a register');
            if (rtx.address.type !== 'register') throw debug('Need a register');
            return [`sb ${rtx.contents.destination}, (${rtx.address.destination})`];
        case 'call':
            return [`jal ${rtx.function}`];
        case 'returnToCaller':
            return [`jr $ra`];
        case 'push':
            if (rtx.register.type !== 'register') throw debug('todo');
            return [`sw ${rtx.register.destination}, ($sp)`, `addiu, $sp, $sp, -4`];
        case 'pop':
            if (rtx.register.type !== 'register') throw debug('todo');
            return [`addiu $sp, $sp, 4`, `lw ${rtx.register.destination}, ($sp)`];
        default:
            throw debug(`${(rtx as any).kind} unhandled in registerTransferExpressionToMipsWithoutComment`);
    }
};

const registerTransferExpressionToMips = (rtx: RegisterTransferLanguageExpression): string[] => {
    if (typeof rtx == 'string') return [rtx];
    return registerTransferExpressionToMipsWithoutComment(rtx).map(asm => `${asm} # ${rtx.why}`);
};

const syscallNumbers = {
    print: 4,
    sbrk: 9,
    mmap: 0, // There is no mmap. Should be unused on mips.
    exit: 10,
};

const bytesInWord = 4;

const stringLiteralDeclaration = (literal: StringLiteralData) =>
    `${stringLiteralName(literal)}: .asciiz "${literal.value}"`;

const preamble: RegisterTransferLanguageExpression[] = [
    { kind: 'push', register: { type: 'register', destination: '$ra' }, why: 'Always save return address' },
];
const eplilogue: RegisterTransferLanguageExpression[] = [
    { kind: 'pop', register: { type: 'register', destination: '$ra' }, why: 'Always restore return address' },
];

const runtimeFunctions: RegisterTransferLanguageExpression[][] = [
    length,
    printWithPrintRuntimeFunction,
    stringEqualityRuntimeFunction,
    stringCopy,
    mallocWithSbrk,
    myFreeRuntimeFunction,
    stringConcatenateRuntimeFunction,
    verifyNoLeaks,
].map(f => f(bytesInWord, syscallNumbers, knownRegisters, preamble, eplilogue));

const toExectuable = ({ functions, program, globalDeclarations, stringLiterals }: BackendInputs) => {
    let mipsFunctions = functions.map(f =>
        constructFunction(
            f,
            globalDeclarations,
            stringLiterals,
            knownRegisters,
            firstRegister,
            nextTemporary,
            preamble,
            eplilogue,
            makeLabel
        )
    );

    const { registerAssignment, firstTemporary } = assignMipsRegisters(program.variables);
    let mipsProgram = flatten(
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
                knownRegisters,
                nextTemporary,
                makeLabel
            );

            return [...compiledProgram.prepare, ...compiledProgram.execute, ...compiledProgram.cleanup];
        })
    );

    const freeGlobals: RegisterTransferLanguageExpression[] = flatten(
        globalDeclarations.filter(declaration => declaration.type.name === 'String').map(declaration => [
            {
                kind: 'loadGlobal',
                from: declaration.name,
                to: knownRegisters.argument1,
                why: 'Load global string so we can free it',
            } as RegisterTransferLanguageExpression,
            {
                kind: 'call',
                function: 'my_free',
                why: 'Free gloabal string at end of program',
            } as RegisterTransferLanguageExpression,
        ])
    );

    // Create space for spilled tempraries
    const numSpilledTemporaries = program.temporaryCount - 10;
    const makeSpillSpaceCode =
        numSpilledTemporaries > 0
            ? [`# Make spill space for main program`, `addiu $sp, $sp, -${numSpilledTemporaries * 4}`]
            : [];
    const removeSpillSpaceCode =
        numSpilledTemporaries > 0
            ? [`# Clean spill space for main program`, `addiu $sp, $sp, ${numSpilledTemporaries * 4}`]
            : [];

    return `
.data
${globalDeclarations.map(name => `${name.name}: .word 0`).join('\n')}
${stringLiterals.map(stringLiteralDeclaration).join('\n')}
${Object.keys(errors)
        .map(key => `${errors[key].name}: .asciiz "${errors[key].value}"`)
        .join('\n')}

# First block pointer. Block: size, next, free
first_block: .word 0

.text
${join(flatten(flatten(runtimeFunctions).map(registerTransferExpressionToMips)), '\n')}

${join(flatten(flatten(mipsFunctions).map(registerTransferExpressionToMips)), '\n')}
main:
${makeSpillSpaceCode.join('\n')}
${join(flatten(mipsProgram.map(registerTransferExpressionToMips)), '\n')}
${removeSpillSpaceCode.join('\n')}
${join(flatten(freeGlobals.map(registerTransferExpressionToMips)), '\n')}
${join(registerTransferExpressionToMips({ kind: 'call', function: ' verify_no_leaks', why: 'Check for leaks' }), '\n')}
# print "exit code" and exit
li $v0, 1
syscall
li $v0, 10
syscall`;
};

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
        const mipsExitCode = parseInt(lines[lines.length - 1].match(/[0-9]*$/)[0]);
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

export default {
    name: 'mips',
    toExectuable,
    execute,
    debug: path => exec(`${__dirname}/../../QtSpim.app/Contents/MacOS/QtSpim ${path}`),
    runtimeFunctions,
};
