import debug from './util/debug.js';
import { StringLiteralData, Backend, VariableDeclaration } from './api.js';
import flatten from './util/list/flatten.js';
import { Statement } from './threeAddressCode/Statement.js';
import { Statement as TargetStatement } from './targetCode/Statement.js';
import { Program } from './threeAddressCode/Program.js';
import { RegisterAgnosticTargetInfo, TargetInfo, TargetRegisters } from './TargetInfo.js';
import { toTarget, StackUsage } from './targetCode/Function.js';
import { Register } from './register.js';
import join from './util/join.js';

import mipsBackend from './backends/mips.js';
import jsBackend from './backends/js.js';
import cBackend from './backends/c.js';
import x64Backend from './backends/x64.js';

export const preceedingWhitespace = <TargetRegister>(
    tas: TargetStatement<TargetRegister>
): string => {
    switch (tas.kind) {
        case 'label':
            return '';
        case 'functionLabel':
            return '\n\n';
        default:
            return '    ';
    }
};

export type CompiledExpression<T> = {
    prepare: T[];
    execute: T[];
    cleanup: T[];
};

export type CompiledAssignment<T> = {
    prepare: T[];
    execute: T[];
    cleanup: T[];
};

export type CompiledProgram<T> = {
    prepare: T[];
    execute: T[];
    cleanup: T[];
};

type ExpressionCompiler<T> = (expressions: T[][]) => T[];
export const compileExpression = <T>(
    subExpressions: CompiledExpression<T>[],
    expressionCompiler: ExpressionCompiler<T>
): CompiledExpression<T> => ({
    prepare: flatten(subExpressions.map(input => input.prepare)),
    execute: expressionCompiler(subExpressions.map(input => input.execute)),
    cleanup: flatten(subExpressions.reverse().map(input => input.cleanup)),
});

export const stringLiteralName = ({ id, value }: StringLiteralData) =>
    `string_literal_${id}_${value.replace(/[^a-zA-Z]/g, '')}`;

export type RegisterAssignment<TargetRegister> = {
    registerMap: { [key: string]: TargetRegister };
    spilled: string[];
};

export const arrangeArgumentsForFunctionCall = <TargetRegister>(
    args: (Register | Number)[],
    getRegister: (r: Register) => TargetRegister,
    registers: TargetRegisters<TargetRegister>
): TargetStatement<TargetRegister>[] => {
    // TODO: Add some type check to ensure we have the right number of arguments
    return args.map((arg, index) => {
        if (index < registers.functionArgument.length) {
            // Registers that fix in arguments go in arguments
            if (typeof arg == 'number') {
                return {
                    kind: 'loadImmediate',
                    value: arg,
                    destination: registers.functionArgument[index],
                    why: `Pass arg ${index} in register`,
                };
            } else {
                return {
                    kind: 'move',
                    from: getRegister(arg as Register),
                    to: registers.functionArgument[index],
                    why: `Pass arg ${index} in register`,
                };
            }
        } else {
            // Registers that don't fit in arguments go on the stack, starting 1 space above the current stack pointer, going up
            if (typeof arg == 'number') {
                throw debug(
                    "arrangeArgumentsForFunctionCall doesn't support literals on stack yet"
                );
            } else {
                const stackSlot = index - registers.functionArgument.length;
                return {
                    kind: 'stackStore',
                    register: getRegister(arg as Register),
                    offset: -stackSlot,
                    why: `Pass arg ${index} on stack (slot ${stackSlot})`,
                };
            }
        }
    });
};

export const saveFunctionCallResult = <TargetRegister>(
    destination: Register | null,
    getRegister: (r: Register) => TargetRegister,
    registers: TargetRegisters<TargetRegister>
): TargetStatement<TargetRegister>[] => {
    if (!destination) {
        return [];
    }
    return [
        {
            kind: 'move',
            from: registers.functionResult,
            to: getRegister(destination),
            why: 'save result',
        },
    ];
};

export type TranslatedFunction = {
    name?: string; // Only main may not have a name
    instructions: string[];
    stackUsage: StackUsage;
};

export type Executable = {
    main: TranslatedFunction;
    functions: TranslatedFunction[];
};

const functionToString = (
    commentChar: string,
    { name, instructions, stackUsage }: TranslatedFunction
): string => {
    if (!name) debug('no name here');
    return `
${name}: ${commentChar} stack: [${join(stackUsage, ', ')}]
${join(instructions, '\n')}`;
};

export const executableToString = (
    commentChar: string,
    { main, functions }: Executable
): string => {
    // Main needs to be first for MARS, which just executes from the top of the file
    return `
${functionToString(commentChar, main)}
${join(
    functions.map(f => functionToString(commentChar, f)),
    '\n'
)}`;
};

export const makeExecutable = <TargetRegister>(
    { functions, main }: Program,
    { syscallNumbers }: RegisterAgnosticTargetInfo,
    targetRegisterInfo: TargetInfo<TargetRegister>,
    translator,
    includeCleanup: boolean
): Executable => {
    if (!main) throw debug('no main');
    const targetFunctions = functions.map(f =>
        toTarget({
            threeAddressFunction: f,
            targetInfo: targetRegisterInfo,
            finalCleanup: [{ kind: 'return', why: 'The Final Return!' }],
            isMain: false,
        })
    );
    const targetMain = toTarget({
        threeAddressFunction: main,
        targetInfo: targetRegisterInfo,
        finalCleanup: [
            // TODO: push/pop exit code is jank and should be removed.
            {
                kind: 'push',
                register: targetRegisterInfo.registers.functionResult,
                why:
                    "Need to save exit code so it isn't clobbber by free_globals/verify_no_leaks",
            },
            ...(includeCleanup
                ? [
                      {
                          kind: 'callByName' as 'callByName',
                          function: 'free_globals',
                          why: 'free_globals',
                      },
                      {
                          kind: 'callByName' as 'callByName',
                          function: 'verify_no_leaks',
                          why: 'verify_no_leaks',
                      },
                  ]
                : []),
            {
                kind: 'pop' as 'pop',
                register: targetRegisterInfo.registers.syscallArgument[0],
                why: 'restore exit code',
            },
            {
                kind: 'loadImmediate' as 'loadImmediate',
                destination: targetRegisterInfo.registers.syscallSelectAndResult,
                value: syscallNumbers.exit,
                why: 'prepare to exit',
            },
            { kind: 'syscall' as 'syscall', why: 'exit' },
        ],
        isMain: true,
    });
    return {
        main: {
            instructions: flatten(targetMain.instructions.map(translator)),
            stackUsage: targetMain.stackUsage,
        },
        functions: targetFunctions.map(({ name, instructions, stackUsage }) => ({
            name,
            stackUsage,
            instructions: flatten(instructions.map(translator)),
        })),
    };
};

// TODO: Move map to outside?
export const freeGlobalsInstructions = (
    globals: VariableDeclaration[],
    makeTemporary,
    globalNameMap
): Statement[] => {
    const instructions: Statement[] = flatten(
        globals
            .filter(declaration => ['String', 'List'].includes(declaration.type.kind))
            .map(declaration => {
                const globalStringAddress = makeTemporary('gobalStringAddress');
                return [
                    {
                        kind: 'loadGlobal',
                        from: globalNameMap[declaration.name].newName,
                        to: globalStringAddress,
                        why: 'Load global string so we can free it',
                    },
                    {
                        kind: 'callByName',
                        function: 'my_free',
                        arguments: [globalStringAddress],
                        destination: null,
                        why: 'Free global string at end of program',
                    },
                ];
            })
    );
    instructions.push({
        kind: 'return' as 'return',
        register: { name: 'dummyReturn' },
        why:
            'Need to not have an empty function, otherwise verifyingOverlappingJoin fails. TODO: fix that.',
    });
    return instructions;
};

export const backends: Backend[] = [mipsBackend, jsBackend, cBackend, x64Backend];
