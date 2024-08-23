import debug from './util/debug';
import { Type } from './types';
import { StringLiteralData, Backend, Variable } from './api';
import { Statement } from './threeAddressCode/Statement';
import { Statement as TargetStatement } from './targetCode/Statement';
import { Program } from './threeAddressCode/Program';
import { RegisterAgnosticTargetInfo, TargetInfo, TargetRegisters } from './TargetInfo';
import { toTarget } from './targetCode/Function';
import { StackUsage, stackUsageToString } from './targetCode/StackUsage';
import { Register } from './threeAddressCode/Register';
import join from './util/join';

import mipsBackend from './backends/mips';
import jsBackend from './backends/js';
import cBackend from './backends/c';
import x64Backend from './backends/x64';

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
    prepare: subExpressions.map(input => input.prepare).flat(),
    execute: expressionCompiler(subExpressions.map(input => input.execute)),
    cleanup: subExpressions
        .reverse()
        .map(input => input.cleanup)
        .flat(),
});

export const stringLiteralName = ({ id, value }: StringLiteralData) =>
    `string_literal_${id}_${value.replace(/[^a-zA-Z]/g, '')}`;

export type RegisterAssignment<TargetRegister> = {
    registerMap: { [key: string]: TargetRegister };
    spilled: string[];
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
    stackUsage: StackUsage<string>; // Done because the whole point of TranslatedFunction is to not template on the register type. TODO: don't make register type a template
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
${name}: ${commentChar} stack: ${stackUsageToString(stackUsage)}
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
                why: "Need to save exit code so it isn't clobbber by free_globals/verify_no_leaks",
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
            instructions: targetMain.instructions.map(translator).flat() as any,
            stackUsage: targetMain.stackUsage as any,
        },
        functions: targetFunctions.map(({ name, instructions, stackUsage }) => ({
            name,
            stackUsage,
            instructions: instructions.map(translator).flat(),
        })) as any,
    };
};

// TODO: Move map to outside?
export const freeGlobalsInstructions = (
    globals: Variable[],
    makeTemporary,
    globalNameMap
): Statement[] => {
    const instructions: Statement[] = globals
        .filter(declaration => ['String', 'List'].includes((declaration.type as Type).type.kind))
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
        .flat() as any;
    instructions.push({
        kind: 'return' as 'return',
        register: new Register('dummyReturn'),
        why: 'Need to not have an empty function, otherwise verifyingOverlappingJoin fails. TODO: fix that.',
    });
    return instructions;
};

export const backends: Backend[] = [mipsBackend, jsBackend, cBackend, x64Backend];
