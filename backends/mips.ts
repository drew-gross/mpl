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
    StorageSpec,
    RegisterAssignment,
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

const firstRegister: StorageSpec = { type: 'register', destination: '$t1' };
const nextTemporary = (storage: StorageSpec): StorageSpec => {
    if (typeof storage == 'string') throw debug('nextTemporary not valid for special registers');
    if (storage.type == 'register') {
        if (storage.destination == '$t9') {
            // Now need to spill
            return {
                type: 'memory',
                spOffset: 0,
            };
        } else {
            return {
                type: 'register',
                destination: `$t${parseInt(storage.destination[storage.destination.length - 1]) + 1}`,
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

const assignMipsRegisters = (
    variables: VariableDeclaration[]
): { registerAssignment: RegisterAssignment; firstTemporary: StorageSpec } => {
    // TODO: allow spilling of variables
    let currentRegister = 0;
    let registerAssignment = {};
    variables.forEach(variable => {
        registerAssignment[variable.name] = {
            type: 'register',
            destination: `$t${currentRegister}`,
        };
        currentRegister = currentRegister + 1;
    });
    return {
        registerAssignment,
        firstTemporary: {
            type: 'register',
            destination: `$t${currentRegister}`,
        },
    };
};

const specialRegisterNames = {
    functionArgument1: '$s0',
    functionArgument2: '$s1',
    functionArgument3: '$s2',
    functionResult: '$a0',
};
const getRegisterName = (r: StorageSpec): string => {
    let result = '';
    if (typeof r == 'string') {
        result = specialRegisterNames[r];
    } else {
        if (r.type == 'memory') throw debug('spilling not supported by this function');
        result = r.destination;
    }
    if (result == 'functionArgument1') debugger;
    return result;
};

const registerTransferExpressionToMipsWithoutComment = (rtx: RegisterTransferLanguageExpression): string[] => {
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
                if (rtx.destination && getRegisterName(rtx.destination) == argRegister) {
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
                            : `move ${syscallArgRegisters[index]}, ${getRegisterName(arg)}`
                ),
                `li ${syscallSelectAndResultRegister}, ${syscallNumbers[rtx.name]}`,
                'syscall',
                ...(rtx.destination
                    ? [`move ${getRegisterName(rtx.destination)}, ${syscallSelectAndResultRegister}`]
                    : []),
                ...flatten(registersToSave.reverse().map(r => [`addiu $sp, $sp, 4`, `lw ${r}, ($sp)`])),
            ];
            return result;
        case 'move':
            return [`move ${getRegisterName(rtx.to)}, ${getRegisterName(rtx.from)}`];
        case 'loadImmediate':
            if (typeof rtx.destination == 'string') {
                return [`li ${getRegisterName(rtx.destination)}, ${rtx.value}`];
            }
            switch (rtx.destination.type) {
                case 'register':
                    return [`li ${getRegisterName(rtx.destination)}, ${rtx.value}`];
                // TODO: use a register allocator
                case 'memory':
                    return [`li $s7, ${rtx.value}`, `sw $s7, -${rtx.destination.spOffset}($sp)`];
                default:
                    throw debug('todo');
            }
        case 'multiply': {
            let leftRegister;
            let loadSpilled: any = [];
            let restoreSpilled: any = [];
            if (typeof rtx.lhs != 'string' && rtx.lhs.type == 'memory') {
                leftRegister = '$s1';
                loadSpilled.push(`lw $s1, -${rtx.lhs.spOffset}($sp)`);
            } else {
                leftRegister = getRegisterName(rtx.lhs);
            }

            let rightRegister;
            if (typeof rtx.rhs != 'string' && rtx.rhs.type == 'memory') {
                rightRegister = '$s2';
                loadSpilled.push(`lw $s2, -${rtx.rhs.spOffset}($sp)`);
            } else {
                rightRegister = getRegisterName(rtx.rhs);
            }

            let destinationRegister;
            if (typeof rtx.destination != 'string' && rtx.destination.type == 'memory') {
                destinationRegister = '$s3';
                restoreSpilled.push(`sw $s3, -${rtx.destination.spOffset}($sp)`);
            } else {
                destinationRegister = getRegisterName(rtx.destination);
            }

            return [
                ...loadSpilled,
                `mult ${leftRegister}, ${rightRegister}`,
                `# Move result to final destination (assume no overflow)`,
                `mflo ${destinationRegister}`,
                ...restoreSpilled,
            ];
        }
        case 'addImmediate':
            return [`addiu ${getRegisterName(rtx.register)}, ${rtx.amount}`];
        case 'add':
            return [
                `add ${getRegisterName(rtx.destination)}, ${getRegisterName(rtx.lhs)}, ${getRegisterName(rtx.rhs)}`,
            ];
        case 'returnValue':
            return [`move ${specialRegisterNames.functionResult}, ${getRegisterName(rtx.source)}`];
        case 'subtract':
            return [
                `sub ${getRegisterName(rtx.destination)}, ${getRegisterName(rtx.lhs)}, ${getRegisterName(rtx.rhs)}`,
            ];
        case 'increment':
            return [`addiu ${getRegisterName(rtx.register)}, ${getRegisterName(rtx.register)}, 1`];
        case 'label':
            return [`L${rtx.name}:`];
        case 'functionLabel':
            return [`${rtx.name}:`];
        case 'goto':
            return [`b L${rtx.label}`];
        case 'gotoIfEqual':
            return [`beq ${getRegisterName(rtx.lhs)}, ${getRegisterName(rtx.rhs)}, L${rtx.label}`];
        case 'gotoIfNotEqual':
            return [`bne ${getRegisterName(rtx.lhs)}, ${getRegisterName(rtx.rhs)}, L${rtx.label}`];
        case 'gotoIfZero':
            return [`beq ${getRegisterName(rtx.register)}, 0, L${rtx.label}`];
        case 'gotoIfGreater':
            return [`bgt ${getRegisterName(rtx.lhs)}, ${getRegisterName(rtx.rhs)}, L${rtx.label}`];
        case 'loadSymbolAddress':
            return [`la ${getRegisterName(rtx.to)}, ${rtx.symbolName}`];
        case 'loadGlobal':
            return [`lw ${getRegisterName(rtx.to)}, ${rtx.from}`];
        case 'storeGlobal':
            return [`sw ${getRegisterName(rtx.from)}, ${getRegisterName(rtx.to)}`];
        case 'loadMemory':
            return [`lw ${getRegisterName(rtx.to)}, ${rtx.offset}(${getRegisterName(rtx.from)})`];
        case 'loadMemoryByte':
            return [`lb ${getRegisterName(rtx.to)}, (${getRegisterName(rtx.address)})`];
        case 'storeMemory':
            return [`sw ${getRegisterName(rtx.from)}, ${rtx.offset}(${getRegisterName(rtx.address)})`];
        case 'storeZeroToMemory':
            return [`sw $0, ${rtx.offset}(${getRegisterName(rtx.address)})`];
        case 'storeMemoryByte':
            return [`sb ${getRegisterName(rtx.contents)}, (${getRegisterName(rtx.address)})`];
        case 'callByRegister':
            return [`jal ${getRegisterName(rtx.function)}`];
        case 'callByName':
            return [`jal ${rtx.function}`];
        case 'returnToCaller':
            return [`jr $ra`];
        case 'push':
            return [`sw ${getRegisterName(rtx.register)}, ($sp)`, `addiu, $sp, $sp, -4`];
        case 'pop':
            return [`addiu $sp, $sp, 4`, `lw ${getRegisterName(rtx.register)}, ($sp)`];
        default:
            throw debug(`${(rtx as any).kind} unhandled in registerTransferExpressionToMipsWithoutComment`);
    }
};

const registerTransferExpressionToMips = (rtx: RegisterTransferLanguageExpression): string[] => {
    if (typeof rtx == 'string') return [rtx];
    return registerTransferExpressionToMipsWithoutComment(rtx).map(asm => `${asm} # ${rtx.why}`);
};

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

const runtimeFunctions: RegisterTransferLanguageFunction[] = mipsRuntime.map(f =>
    f(bytesInWord, firstRegister, nextTemporary)
);

// TODO: degeneralize this (allowing removal of several RTL instructions)
const rtlFunctionToMips = ({
    name,
    instructions,
    numRegistersToSave,
    isMain,
}: RegisterTransferLanguageFunction): string => {
    const preamble = !isMain
        ? [
              { kind: 'push', register: { type: 'register', destination: '$ra' }, why: 'Always save return address' },
              ...saveRegistersCode(firstRegister, nextTemporary, numRegistersToSave),
          ]
        : [];
    const epilogue = !isMain
        ? [
              ...restoreRegistersCode(firstRegister, nextTemporary, numRegistersToSave),
              { kind: 'pop', register: { type: 'register', destination: '$ra' }, why: 'Always restore return address' },
              { kind: 'returnToCaller', why: 'Done' },
          ]
        : [];
    const fullRtl = [
        { kind: 'functionLabel', name, why: 'Function entry point' },
        ...preamble,
        ...instructions,
        ...epilogue,
    ];
    return join(flatten(fullRtl.map(registerTransferExpressionToMips)), '\n');
};

const toExectuable = ({ functions, program, globalDeclarations, stringLiterals }: BackendInputs) => {
    let mipsFunctions = functions.map(f =>
        constructFunction(f, globalDeclarations, stringLiterals, firstRegister, nextTemporary, makeLabel)
    );

    const { registerAssignment, firstTemporary } = assignMipsRegisters(program.variables);

    const mainProgramInstructions: RegisterTransferLanguageExpression[] = flatten(
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

    const freeGlobals: RegisterTransferLanguageExpression[] = flatten(
        globalDeclarations.filter(declaration => declaration.type.name === 'String').map(declaration => [
            {
                kind: 'loadGlobal',
                from: declaration.name,
                to: 'functionArgument1',
                why: 'Load global string so we can free it',
            } as RegisterTransferLanguageExpression,
            {
                kind: 'callByName',
                function: 'my_free',
                why: 'Free gloabal string at end of program',
            } as RegisterTransferLanguageExpression,
        ])
    );

    // Create space for spilled tempraries
    const numSpilledTemporaries = program.temporaryCount - 10;
    const makeSpillSpaceCode: RegisterTransferLanguageExpression[] =
        numSpilledTemporaries > 0
            ? [
                  {
                      kind: 'addImmediate',
                      register: { type: 'register', destination: '$sp' },
                      amount: -4 * numSpilledTemporaries,
                      why: 'Make spill space for main program',
                  },
              ]
            : [];
    const removeSpillSpaceCode: RegisterTransferLanguageExpression[] =
        numSpilledTemporaries > 0
            ? [
                  {
                      kind: 'addImmediate',
                      register: { type: 'register', destination: '$sp' },
                      amount: 4 * numSpilledTemporaries,
                      why: 'Remove spill space for main program',
                  },
              ]
            : [];

    let mipsProgram: RegisterTransferLanguageFunction = {
        name: 'main',
        numRegistersToSave: 0, // No need to save registers, there is nothing higher in the stack that we could clobber
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
