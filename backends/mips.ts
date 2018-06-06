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
    RegisterAssignment,
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
} from './threeAddressCodeRuntime.js';
import { errors } from '../runtime-strings.js';
import { builtinFunctions } from '../frontend.js';
import join from '../util/join.js';

const firstRegister: Register = { name: '$t1' };
const nextTemporary = (r: Register): Register => {
    if (typeof r == 'string') throw debug('nextTemporary not valid for special registers');
    if (r.name == '$t9') {
        throw debug('spilling removed for now');
    }
    return { name: `$t${parseInt(r.name[r.name.length - 1]) + 1}` };
};

let labelId = 0;
const makeLabel = (name: string) => {
    const result = `${name}${labelId}`;
    labelId++;
    return result;
};

const assignMipsRegisters = (
    variables: VariableDeclaration[]
): { registerAssignment: RegisterAssignment; firstTemporary: Register } => {
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
        firstTemporary: { name: `$t${currentRegister}` },
    };
};

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

const getMipsRegister = (r: Register): MipsRegister => {
    if (typeof r == 'string') {
        switch (r) {
            case 'functionArgument1':
                return mipsRegisterTypes.functionArgument[0];
            case 'functionArgument2':
                return mipsRegisterTypes.functionArgument[1];
            case 'functionArgument3':
                return mipsRegisterTypes.functionArgument[2];
            case 'functionResult':
                return mipsRegisterTypes.functionResult;
        }
    } else {
        return r.name as MipsRegister;
    }
    throw debug('should not get here');
};

const syscallNumbers = {
    printInt: 1,
    print: 4,
    sbrk: 9,
    // mmap: 0, // There is no mmap. Should be unused on mips.
    exit: 10,
};

const threeAddressCodeToMipsWithoutComment = (tas: TargetThreeAddressStatement<MipsRegister>): string[] => {
    switch (tas.kind) {
        case 'comment':
            return [''];
        case 'syscall':
            return ['syscall'];
        case 'move':
            return [`move ${tas.to}, ${tas.from}`];
        case 'loadImmediate':
            if (!tas.destination) throw debug('missint!');

            return [`li ${tas.destination}, ${tas.value}`];
        case 'multiply': {
            return [`mult ${tas.lhs}, ${tas.rhs}`, `mflo ${tas.destination}`];
        }
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
        default:
            throw debug(`${(tas as any).kind} unhandled in threeAddressCodeToMipsWithoutComment`);
    }
};

const threeAddressCodeToMips = (tas: ThreeAddressStatement): string[] => {
    return threeAddressCodeToTarget(tas, syscallNumbers, mipsRegisterTypes, getMipsRegister)
        .map(threeAddressCodeToMipsWithoutComment)
        .map(asm => `${asm} # ${tas.why}`);
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

const runtimeFunctions: ThreeAddressFunction[] = mipsRuntime.map(f => f(bytesInWord, firstRegister, nextTemporary));

// TODO: degeneralize this (allowing removal of several RTL instructions)
const rtlFunctionToMips = ({ name, instructions, numRegistersToSave, isMain }: ThreeAddressFunction): string => {
    const statements: TargetThreeAddressStatement<MipsRegister>[] = flatten(
        instructions.map(instruction =>
            threeAddressCodeToTarget(instruction, syscallNumbers, mipsRegisterTypes, getMipsRegister)
        )
    );

    const preamble: TargetThreeAddressStatement<MipsRegister>[] = !isMain
        ? [
              { kind: 'push', register: '$ra', why: 'Always save return address' },
              ...saveRegistersCode<MipsRegister>(firstRegister, nextTemporary, getMipsRegister, numRegistersToSave),
          ]
        : [];
    const epilogue: TargetThreeAddressStatement<MipsRegister>[] = !isMain
        ? [
              ...restoreRegistersCode<MipsRegister>(firstRegister, nextTemporary, getMipsRegister, numRegistersToSave),
              { kind: 'pop', register: '$ra', why: 'Always restore return address' },
              { kind: 'returnToCaller', why: 'Done' },
          ]
        : [];
    const fullRtl: TargetThreeAddressStatement<MipsRegister>[] = [
        { kind: 'functionLabel', name, why: 'Function entry point' },
        ...preamble,
        ...statements,
        ...epilogue,
    ];
    return join(flatten(fullRtl.map(threeAddressCodeToMipsWithoutComment)), '\n');
};

const toExectuable = ({ functions, program, globalDeclarations, stringLiterals }: BackendInputs) => {
    let mipsFunctions = functions.map(f =>
        constructFunction(f, globalDeclarations, stringLiterals, firstRegister, nextTemporary, makeLabel)
    );

    const { registerAssignment, firstTemporary } = assignMipsRegisters(program.variables);

    const mainProgramInstructions: ThreeAddressStatement[] = flatten(
        program.statements.map(statement => {
            const compiledProgram = astToThreeAddressCode(
                {
                    ast: statement,
                    registerAssignment,
                    destination: { name: '$a0' },
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

    const freeGlobals: ThreeAddressStatement[] = flatten(
        globalDeclarations.filter(declaration => declaration.type.name === 'String').map(declaration => [
            {
                kind: 'loadGlobal',
                from: declaration.name,
                to: 'functionArgument1',
                why: 'Load global string so we can free it',
            } as ThreeAddressStatement,
            {
                kind: 'callByName',
                function: 'my_free',
                why: 'Free gloabal string at end of program',
            } as ThreeAddressStatement,
        ])
    );

    // Create space for spilled tempraries
    const numSpilledTemporaries = program.temporaryCount - 10;
    const makeSpillSpaceCode: ThreeAddressStatement[] =
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
    const removeSpillSpaceCode: ThreeAddressStatement[] =
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

    let mipsProgram: ThreeAddressFunction = {
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
