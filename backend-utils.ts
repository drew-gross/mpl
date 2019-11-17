import idAppender from './util/idAppender.js';
import debug from './util/debug.js';
import { StringLiteralData, Backend, VariableDeclaration } from './api.js';
import flatten from './util/list/flatten.js';
import {
    TargetThreeAddressStatement,
    ThreeAddressFunction,
    ThreeAddressProgram,
    TargetInfo,
    TargetRegisterInfo,
    RegisterDescription,
} from './threeAddressCode/generator.js';
import tacToTarget from './threeAddressCode/toTarget.js';
import { Statement, reads, writes } from './threeAddressCode/statement.js';
import { isEqual } from './register.js';
import { assignRegisters } from './controlFlowGraph.js';
import { orderedSet, operatorCompare } from './util/ordered-set.js';
import join from './util/join.js';

import mipsBackend from './backends/mips.js';
import jsBackend from './backends/js.js';
import cBackend from './backends/c.js';
import x64Backend from './backends/x64.js';

export const preceedingWhitespace = <TargetRegister>(tas: TargetThreeAddressStatement<TargetRegister>): string => {
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

type TacToTargetInput<TargetRegister> = {
    threeAddressFunction: ThreeAddressFunction;
    extraSavedRegisters: TargetRegister[];
    registers: RegisterDescription<TargetRegister>;
    syscallNumbers: any;
    registersClobberedBySyscall: TargetRegister[];
    finalCleanup: TargetThreeAddressStatement<TargetRegister>[];
    isMain: boolean; // Controls whether to save/restore registers
};

type StackUsage = {
    arguments: number;
    savedRegisters: number;
};

type TargetFunction<TargetRegister> = {
    name: string;
    instructions: TargetThreeAddressStatement<TargetRegister>[];
    stackUsage: StackUsage;
};

const tacToTargetFunction = <TargetRegister>({
    threeAddressFunction,
    registers,
    syscallNumbers,
    extraSavedRegisters,
    registersClobberedBySyscall,
    finalCleanup,
    isMain,
}: TacToTargetInput<TargetRegister>): TargetFunction<TargetRegister> => {
    const temporaryNameMaker = idAppender();
    const makeTemporary = name => ({ name: temporaryNameMaker(name) });
    const argumentStackOffset = r => {
        const argIndex = threeAddressFunction.arguments.findIndex(arg => isEqual(arg, r));
        if (argIndex < registers.functionArgument.length) {
            return undefined;
        }
        return argIndex - registers.functionArgument.length;
    };

    const stackSlotsForArguments = threeAddressFunction.arguments.length - registers.functionArgument.length;

    const instructionsWithArgsFromStack: Statement[] = flatten(
        threeAddressFunction.instructions.map(tas => {
            if (writes(tas).some(r => argumentStackOffset(r) !== undefined)) {
                debug('tried to write to an arg');
            }
            const result: Statement[] = [];
            switch (tas.kind) {
                case 'move':
                    let from = tas.from;
                    const fromOffset = argumentStackOffset(tas.from);
                    if (fromOffset !== undefined) {
                        from = makeTemporary(`load_arg_${from.name}`);
                        if (!from) debug('!from');
                        result.push({
                            kind: 'unspill',
                            register: from,
                            offset: fromOffset,
                            why: 'Load arg from stack',
                        });
                    }
                    const toOffset = argumentStackOffset(tas.to);
                    if (toOffset !== undefined) debug('writing to args is not allowed');
                    result.push({ ...tas, from });
                    break;
                case 'add':
                    let lhs = tas.lhs;
                    const lhsOffset = argumentStackOffset(tas.lhs);
                    if (lhsOffset !== undefined) {
                        lhs = makeTemporary(`load_arg_${lhs.name}`);
                        result.push({
                            kind: 'unspill',
                            register: lhs,
                            offset: lhsOffset,
                            why: 'Load arg from stack',
                        });
                    }
                    let rhs = tas.rhs;
                    const rhsOffset = argumentStackOffset(tas.rhs);
                    if (rhsOffset !== undefined) {
                        rhs = makeTemporary(`load_arg_${rhs.name}`);
                        result.push({
                            kind: 'unspill',
                            register: rhs,
                            offset: rhsOffset,
                            why: 'Load arg from stack',
                        });
                    }
                    result.push({ ...tas, lhs, rhs });
                    break;
                default:
                    if (reads(tas, threeAddressFunction.arguments).some(r => argumentStackOffset(r) !== undefined)) {
                        throw debug(
                            `not sure how to convert args to stack loads for ${tas.kind}. ${JSON.stringify(tas)}`
                        );
                    }
                    return [tas];
            }
            return result;
        })
    );

    const functonWithArgsFromStack = { ...threeAddressFunction, instructions: instructionsWithArgsFromStack };

    const { assignment, newFunction: tafWithAssignment } = assignRegisters(
        functonWithArgsFromStack,
        registers.generalPurpose
    );

    const stackOffsetPerInstruction: number[] = [];
    tafWithAssignment.instructions.forEach(i => {
        if (i.kind == 'alloca') {
            stackOffsetPerInstruction.push(i.bytes);
        } else {
            stackOffsetPerInstruction.push(0);
        }
    });

    const exitLabel = `${threeAddressFunction.name}_cleanup`;
    const statements: TargetThreeAddressStatement<TargetRegister>[] = flatten(
        instructionsWithArgsFromStack.map((instruction, index) =>
            tacToTarget(
                instruction,
                stackOffsetPerInstruction[index],
                syscallNumbers,
                registers,
                threeAddressFunction.arguments,
                assignment,
                exitLabel,
                registersClobberedBySyscall
            )
        )
    );

    const usedRegisters = orderedSet<TargetRegister>(operatorCompare);
    Object.values(assignment.registerMap).forEach(usedRegisters.add);

    const instructions: TargetThreeAddressStatement<TargetRegister>[] = [];
    if (!isMain) {
        instructions.push(
            ...extraSavedRegisters.map(r => ({
                kind: 'push' as any,
                register: r,
                why: 'save extra register',
            }))
        );
        instructions.push(
            ...usedRegisters.toList().map(r => ({
                kind: 'push' as 'push',
                register: r,
                why: 'save used register',
            }))
        );
    }
    instructions.push(...statements);
    instructions.push({ kind: 'label', name: exitLabel, why: 'cleanup' });
    if (!isMain) {
        instructions.push(
            ...usedRegisters
                .toList()
                .reverse()
                .map(r => ({
                    kind: 'pop' as 'pop',
                    register: r,
                    why: 'restore used register',
                }))
        );
        instructions.push(
            ...extraSavedRegisters.reverse().map(r => ({
                kind: 'pop' as 'pop',
                register: r,
                why: 'restore extra register',
            }))
        );
    }
    instructions.push(...finalCleanup);
    return {
        name: threeAddressFunction.name,
        instructions,
        stackUsage: {
            arguments: stackSlotsForArguments,
            savedRegisters: extraSavedRegisters.length + usedRegisters.size(),
        },
    };
};

export const makeExecutable = <TargetRegister>(
    { globals, functions, main, stringLiterals }: ThreeAddressProgram,
    { syscallNumbers, mainName }: TargetInfo,
    {
        extraSavedRegisters,
        registersClobberedBySyscall,
        registerDescription,
        translator,
    }: TargetRegisterInfo<TargetRegister>,
    includeCleanup: boolean
) => {
    if (!main) throw debug('need a maim');
    const targetFunctions = functions.map(f =>
        tacToTargetFunction({
            threeAddressFunction: f,
            extraSavedRegisters,
            registers: registerDescription,
            syscallNumbers,
            registersClobberedBySyscall,
            finalCleanup: [{ kind: 'return', why: 'The Final Return!' }],
            isMain: false,
        })
    );

    const targetMain = tacToTargetFunction({
        threeAddressFunction: { ...main, name: mainName },
        extraSavedRegisters: [], // No need to save registers in main
        registers: registerDescription,
        syscallNumbers,
        registersClobberedBySyscall,
        finalCleanup: [
            // TODO: push/pop exit code is jank and should be removed.
            {
                kind: 'push',
                register: registerDescription.functionResult,
                why: "Need to save exit code so it isn't clobbber by free_globals/verify_no_leaks",
            },
            ...(includeCleanup
                ? [
                      { kind: 'callByName' as 'callByName', function: 'free_globals', why: 'free_globals' },
                      { kind: 'callByName' as 'callByName', function: 'verify_no_leaks', why: 'verify_no_leaks' },
                  ]
                : []),
            { kind: 'pop' as 'pop', register: registerDescription.syscallArgument[0], why: 'restore exit code' },
            {
                kind: 'loadImmediate' as 'loadImmediate',
                destination: registerDescription.syscallSelectAndResult,
                value: syscallNumbers.exit,
                why: 'prepare to exit',
            },
            { kind: 'syscall' as 'syscall', why: 'exit' },
        ],
        isMain: true,
    });

    const functionStrings = targetFunctions.map(
        ({ name, instructions }) => `
${name}:
${join(flatten(instructions.map(translator)), '\n')}`
    );

    const mainString = `
${targetMain.name}:
${join(flatten(targetMain.instructions.map(translator)), '\n')}`;

    // Main needs to go first for mars, because mars just starts executing at the top of the file
    return `
${mainString}
${join(functionStrings, '\n')}
`;
};

// TODO: Move map to outside?
export const freeGlobalsInstructions = (globals: VariableDeclaration[], makeTemporary, globalNameMap): Statement[] => {
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
        why: 'Need to not have an empty function, otherwise verifyingOverlappingJoin fails. TODO: fix that.',
    });
    return instructions;
};

export const backends: Backend[] = [mipsBackend, jsBackend, cBackend, x64Backend];
