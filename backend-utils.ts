import idAppender from './util/idAppender.js';
import debug from './util/debug.js';
import { StringLiteralData, Backend } from './api.js';
import flatten from './util/list/flatten.js';
import { TargetThreeAddressStatement, ThreeAddressFunction } from './threeAddressCode/generator.js';
import tacToTarget from './threeAddressCode/toTarget.js';
import { Statement, reads, writes } from './threeAddressCode/statement.js';
import { isEqual } from './register.js';
import { assignRegisters } from './controlFlowGraph.js';
import { orderedSet, operatorCompare } from './util/ordered-set.js';

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

export const saveRegistersCode = <TargetRegister>(
    registerAssignment: RegisterAssignment<TargetRegister>
): TargetThreeAddressStatement<TargetRegister>[] => {
    const usedRegisters = orderedSet<TargetRegister>(operatorCompare);
    Object.values(registerAssignment.registerMap).forEach(usedRegisters.add);
    const result: TargetThreeAddressStatement<TargetRegister>[] = [];
    usedRegisters.forEach(targetRegister => {
        result.push({
            kind: 'push' as 'push',
            register: targetRegister,
            why: 'Push register to preserve it',
        });
    });
    return result;
};

export const restoreRegistersCode = <TargetRegister>(
    registerAssignment: RegisterAssignment<TargetRegister>
): TargetThreeAddressStatement<TargetRegister>[] => {
    const usedRegisters = orderedSet<TargetRegister>(operatorCompare);
    Object.values(registerAssignment.registerMap).forEach(usedRegisters.add);
    let result: TargetThreeAddressStatement<TargetRegister>[] = [];
    usedRegisters.forEach(targetRegister => {
        result.push({
            kind: 'pop' as 'pop',
            register: targetRegister,
            why: 'Restore preserved registers',
        });
    });
    result = result.reverse();
    return result;
};

export type RegisterDescription<TargetRegister> = {
    generalPurpose: TargetRegister[];
    functionArgument: TargetRegister[];
    functionResult: TargetRegister;
    syscallArgument: TargetRegister[];
    syscallSelectAndResult: TargetRegister;
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
type TargetFunction<TargetRegister> = {
    name: string;
    instructions: TargetThreeAddressStatement<TargetRegister>[];
};
export const tacToTargetFunction = <TargetRegister>({
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

    const instructionsWithArgsFromStack: Statement[] = flatten(
        threeAddressFunction.instructions.map(tas => {
            if (writes(tas).some(r => argumentStackOffset(r) !== undefined)) {
                debug('tried to write to an arg');
            }
            const result: Statement[] = [];
            // TODO: Throughout: once Restister always has .name, remove "as any". Only "result" doesn't have a name, and that can't be an arg.
            switch (tas.kind) {
                case 'move':
                    let from = tas.from;
                    const fromOffset = argumentStackOffset(tas.from);
                    if (fromOffset !== undefined) {
                        from = makeTemporary(`load_arg_${(from as any).name}`);
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
                        lhs = makeTemporary(`load_arg_${(lhs as any).name}`);
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
                        rhs = makeTemporary(`load_arg_${(rhs as any).name}`);
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

    debugger;
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

    const instructions: TargetThreeAddressStatement<TargetRegister>[] = [];
    if (!isMain) {
        instructions.push(
            ...extraSavedRegisters.map(r => ({ kind: 'push' as any, register: r, why: 'save to stack' }))
        );
        instructions.push(...saveRegistersCode(assignment));
    }
    instructions.push(...statements);
    instructions.push({ kind: 'label', name: exitLabel, why: 'cleanup' });
    if (!isMain) {
        instructions.push(...restoreRegistersCode(assignment));
        instructions.push(
            ...extraSavedRegisters
                .reverse()
                .map(r => ({ kind: 'pop' as 'pop', register: r, why: 'restore from stack' }))
        );
    }
    instructions.push(...finalCleanup);
    return { name: threeAddressFunction.name, instructions };
};

export const backends: Backend[] = [mipsBackend, jsBackend, cBackend, x64Backend];
