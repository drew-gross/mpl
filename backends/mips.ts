import { exec } from 'child-process-promise';
import { isEqual } from 'lodash';
import flatten from '../util/list/flatten.js';
import { VariableDeclaration, BackendInputs, ExecutionResult, Function, StringLiteralData } from '../api.js';
import * as Ast from '../ast.js';
import debug from '../util/debug.js';
import {
    CompiledProgram,
    BackendOptions,
    compileExpression,
    stringLiteralName,
    saveRegistersCode,
    restoreRegistersCode,
    RegisterAssignment,
} from '../backend-utils.js';
import { Register } from '../register.js';
import {
    astToRegisterTransferLanguage,
    constructFunction,
    RegisterTransferLanguageExpression as RTX,
    RegisterTransferLanguageFunction,
} from './registerTransferLanguage.js';
import {
    mallocWithSbrk,
    length,
    stringCopy,
    verifyNoLeaks,
    printWithPrintRuntimeFunction,
    stringConcatenateRuntimeFunction,
    stringEqualityRuntimeFunction,
    myFreeRuntimeFunction,
    RuntimeFunctionGenerator,
} from './registerTransferLanguageRuntime.js';
import { errors } from '../runtime-strings.js';
import { builtinFunctions } from '../frontend.js';
import join from '../util/join.js';
import idAppender from '../util/idAppender.js';
import { assignRegisters } from '../controlFlowGraph.js';

const generalPurposeRegisters = ['$t1', '$t2', '$t3', '$t4', '$t5', '$t6', '$t7', '$t8', '$t9'];

let labelId = 0;
const makeLabel = (name: string) => {
    const result = `${name}${labelId}`;
    labelId++;
    return result;
};

const specialRegisterNames = {
    functionArgument1: '$s0',
    functionArgument2: '$s1',
    functionArgument3: '$s2',
    functionResult: '$a0',
};

// TODO: split RTL register and target register
const getRegisterName = (registerAssignment: RegisterAssignment, register: Register): string => {
    if (typeof register == 'string') {
        return specialRegisterNames[register];
    } else if (register.name in registerAssignment) {
        return (registerAssignment[register.name] as any).name;
    } else {
        return (register as any).name;
    }
};

const registerTransferExpressionToMipsWithoutComment = (registerAssignment: RegisterAssignment, rtx: RTX): string[] => {
    const getReg = getRegisterName.bind(registerAssignment);
    switch (rtx.kind) {
        case 'comment':
            return [''];
        case 'syscall':
            // TOOD: DRY with syscall impl in mips
            // TODO: find a way to make this less opaque to register allocation so less spilling is necessary
            if (rtx.arguments.length > 2) throw debug('mips only supports 2 syscall args');
            const syscallNumbers = {
                printInt: 1,
                print: 4,
                sbrk: 9,
                // mmap: 0, // There is no mmap. Should be unused on mips.
                exit: 10,
            };
            const syscallArgRegisters = ['$a0', '$a1'];
            const syscallSelectAndResultRegister = '$v0';
            const registersToSave: string[] = [syscallSelectAndResultRegister];
            rtx.arguments.forEach((_, index) => {
                const argRegister = syscallArgRegisters[index];
                if (rtx.destination && getReg(rtx.destination) == argRegister) {
                    return;
                }
                registersToSave.push(argRegister);
            });
            // TODO: Allow a "replacements" feature, to convert complex/unsupported RTL instructions into supported ones
            const result = [
                ...flatten(registersToSave.map(r => [`sw ${r}, ($sp)`, `addiu, $sp, $sp, -4`])),
                ...rtx.arguments.map(
                    (arg, index) =>
                        typeof arg == 'number'
                            ? `li ${syscallArgRegisters[index]}, ${arg}`
                            : `move ${syscallArgRegisters[index]}, ${getReg(arg)}`
                ),
                `li ${syscallSelectAndResultRegister}, ${syscallNumbers[rtx.name]}`,
                'syscall',
                ...(rtx.destination
                    ? [
                          `move ${getRegisterName(
                              registerAssignment,
                              rtx.destination
                          )}, ${syscallSelectAndResultRegister}`,
                      ]
                    : []),
                ...flatten(registersToSave.reverse().map(r => [`addiu $sp, $sp, 4`, `lw ${r}, ($sp)`])),
            ];
            return result;
        case 'move':
            return [`move ${getReg(rtx.to)}, ${getReg(rtx.from)}`];
        case 'loadImmediate':
            return [`li ${getReg(rtx.destination)}, ${rtx.value}`];
        case 'multiply': {
            return [
                `mult ${getReg(rtx.lhs)}, ${getReg(rtx.rhs)}`,
                `# Move result to final destination (assume no overflow)`,
                `mflo ${getReg(rtx.destination)}`,
            ];
        }
        case 'addImmediate':
            return [`addiu ${getReg(rtx.register)}, ${rtx.amount}`];
        case 'add':
            return [`add ${getReg(rtx.destination)}, ${getReg(rtx.lhs)}, ${getReg(rtx.rhs)}`];
        case 'returnValue':
            return [`move ${specialRegisterNames.functionResult}, ${getReg(rtx.source)}`];
        case 'subtract':
            return [`sub ${getReg(rtx.destination)}, ${getReg(rtx.lhs)}, ${getReg(rtx.rhs)}`];
        case 'increment':
            return [`addiu ${getReg(rtx.register)}, ${getReg(rtx.register)}, 1`];
        case 'label':
            return [`L${rtx.name}:`];
        case 'functionLabel':
            return [`${rtx.name}:`];
        case 'goto':
            return [`b L${rtx.label}`];
        case 'gotoIfEqual':
            return [`beq ${getReg(rtx.lhs)}, ${getReg(rtx.rhs)}, L${rtx.label}`];
        case 'gotoIfNotEqual':
            return [`bne ${getReg(rtx.lhs)}, ${getReg(rtx.rhs)}, L${rtx.label}`];
        case 'gotoIfZero':
            return [`beq ${getReg(rtx.register)}, 0, L${rtx.label}`];
        case 'gotoIfGreater':
            return [`bgt ${getReg(rtx.lhs)}, ${getReg(rtx.rhs)}, L${rtx.label}`];
        case 'loadSymbolAddress':
            return [`la ${getReg(rtx.to)}, ${rtx.symbolName}`];
        case 'loadGlobal':
            return [`lw ${getReg(rtx.to)}, ${rtx.from}`];
        case 'storeGlobal':
            return [`sw ${getReg(rtx.from)}, ${getReg(rtx.to)}`];
        case 'loadMemory':
            return [`lw ${getReg(rtx.to)}, ${rtx.offset}(${getReg(rtx.from)})`];
        case 'loadMemoryByte':
            return [`lb ${getReg(rtx.to)}, (${getReg(rtx.address)})`];
        case 'storeMemory':
            return [`sw ${getReg(rtx.from)}, ${rtx.offset}(${getReg(rtx.address)})`];
        case 'storeZeroToMemory':
            return [`sw $0, ${rtx.offset}(${getReg(rtx.address)})`];
        case 'storeMemoryByte':
            return [`sb ${getReg(rtx.contents)}, (${getReg(rtx.address)})`];
        case 'callByRegister':
            return [`jal ${getReg(rtx.function)}`];
        case 'callByName':
            return [`jal ${rtx.function}`];
        case 'returnToCaller':
            return [`jr $ra`];
        case 'push':
            return [`sw ${getReg(rtx.register)}, ($sp)`, `addiu, $sp, $sp, -4`];
        case 'pop':
            return [`addiu $sp, $sp, 4`, `lw ${getReg(rtx.register)}, ($sp)`];
        default:
            throw debug(`${(rtx as any).kind} unhandled in registerTransferExpressionToMipsWithoutComment`);
    }
};

const registerTransferExpressionToMips = (registerAssignment: RegisterAssignment, rtx: RTX): string[] =>
    registerTransferExpressionToMipsWithoutComment(registerAssignment, rtx).map(asm => `${asm} # ${rtx.why}`);

const bytesInWord = 4;

const stringLiteralDeclaration = (literal: StringLiteralData) =>
    `${stringLiteralName(literal)}: .asciiz "${literal.value}"`;

const mipsRuntime: RuntimeFunctionGenerator[] = [
    length,
    printWithPrintRuntimeFunction,
    stringEqualityRuntimeFunction,
    stringCopy,
    mallocWithSbrk,
    myFreeRuntimeFunction,
    stringConcatenateRuntimeFunction,
    verifyNoLeaks,
];

const runtimeFunctions: RegisterTransferLanguageFunction[] = mipsRuntime.map(f => f(bytesInWord));

// TODO: degeneralize this (allowing removal of several RTL instructions)
const rtlFunctionToMips = (rtlf: RegisterTransferLanguageFunction): string => {
    const registerAssignment = assignRegisters(rtlf, generalPurposeRegisters);
    const preamble: RTX[] = !rtlf.isMain
        ? [
              { kind: 'push', register: { name: '$ra' }, why: 'Always save return address' },
              ...saveRegistersCode(registerAssignment),
          ]
        : [];
    const epilogue: RTX[] = !rtlf.isMain
        ? [
              ...restoreRegistersCode(registerAssignment),
              { kind: 'pop', register: { name: '$ra' }, why: 'Always restore return address' },
              { kind: 'returnToCaller', why: 'Done' },
          ]
        : [];
    const fullRtl: RTX[] = [
        { kind: 'functionLabel', name: rtlf.name, why: 'Function entry point' },
        ...preamble,
        ...rtlf.instructions,
        ...epilogue,
    ];
    return join(flatten(fullRtl.map(rtlx => registerTransferExpressionToMips(registerAssignment, rtlx))), '\n');
};

const toExectuable = ({ functions, program, globalDeclarations, stringLiterals }: BackendInputs) => {
    const temporaryNameMaker = idAppender();
    let mipsFunctions = functions.map(f => constructFunction(f, globalDeclarations, stringLiterals, makeLabel));

    const mainProgramInstructions: RTX[] = flatten(
        program.statements.map(statement => {
            const compiledProgram = astToRegisterTransferLanguage({
                ast: statement,
                destination: 'functionResult',
                globalDeclarations,
                stringLiterals,
                makeLabel,
                makeTemporary: name => ({ name: temporaryNameMaker(name) }),
                variablesInScope: {},
            });

            return [...compiledProgram.prepare, ...compiledProgram.execute, ...compiledProgram.cleanup];
        })
    );

    const freeGlobals: RTX[] = flatten(
        globalDeclarations.filter(declaration => declaration.type.name === 'String').map(declaration => [
            {
                kind: 'loadGlobal',
                from: declaration.name,
                to: 'functionArgument1',
                why: 'Load global string so we can free it',
            } as RTX,
            {
                kind: 'callByName',
                function: 'my_free',
                why: 'Free gloabal string at end of program',
            } as RTX,
        ])
    );

    // Create space for spilled tempraries
    const numSpilledTemporaries = program.temporaryCount - 10;
    const makeSpillSpaceCode: RTX[] =
        numSpilledTemporaries > 0
            ? [
                  {
                      kind: 'addImmediate',
                      register: { name: '$sp' },
                      amount: -4 * numSpilledTemporaries,
                      why: 'Make spill space for main program',
                  },
              ]
            : [];
    const removeSpillSpaceCode: RTX[] =
        numSpilledTemporaries > 0
            ? [
                  {
                      kind: 'addImmediate',
                      register: { name: '$sp' },
                      amount: 4 * numSpilledTemporaries,
                      why: 'Remove spill space for main program',
                  },
              ]
            : [];

    let mipsProgram: RegisterTransferLanguageFunction = {
        name: 'main',
        isMain: true,
        instructions: [
            ...makeSpillSpaceCode,
            ...mainProgramInstructions,
            ...removeSpillSpaceCode,
            ...freeGlobals,
            { kind: 'callByName', function: ' verify_no_leaks', why: 'Check for leaks' },
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
    };

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
${join([...runtimeFunctions, ...mipsFunctions, mipsProgram].map(rtlFunctionToMips), '\n\n\n')}`;
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
