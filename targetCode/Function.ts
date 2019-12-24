import idAppender from '../util/idAppender.js';
import {
    Statement as ThreeAddressStatement,
    reads,
    writes,
} from '../threeAddressCode/Statement.js';
import { Function as ThreeAddressFunction } from '../threeAddressCode/Function';
import { isEqual } from '../register.js';
import { assignRegisters } from '../controlFlowGraph.js';
import debug from '../util/debug.js';
import { orderedSet, operatorCompare } from '../util/ordered-set.js';
import flatten from '../util/list/flatten.js';
import { Statement as TargetStatement, toTarget as statementToTarget } from './Statement.js';
import { TargetInfo } from '../TargetInfo.js';

type ToTargetInput<TargetRegister> = {
    threeAddressFunction: ThreeAddressFunction;
    targetInfo: TargetInfo<TargetRegister>;
    finalCleanup: TargetStatement<TargetRegister>[];
    isMain: boolean; // Controls whether to save/restore registers
};

export type StackUsage = string[]; // For not just comment. TODO: structured data

export type Function<TargetRegister> = {
    name: string;
    instructions: TargetStatement<TargetRegister>[];
    stackUsage: StackUsage;
};

export const toTarget = <TargetRegister>({
    threeAddressFunction,
    targetInfo,
    finalCleanup,
    isMain,
}: ToTargetInput<TargetRegister>): Function<TargetRegister> => {
    const stackUsage: StackUsage = [];
    threeAddressFunction.arguments.map((arg, index) => {
        if (index > targetInfo.registers.functionArgument.length) {
            stackUsage.push(`Argument: ${arg.name}`);
        }
    });

    const extraSavedRegisters = isMain ? [] : targetInfo.extraSavedRegisters;

    extraSavedRegisters.forEach(r => {
        stackUsage.push(`Saved extra: ${r}`);
    });

    const temporaryNameMaker = idAppender();
    const makeTemporary = name => ({ name: temporaryNameMaker(name) });
    const argumentStackOffset = r => {
        const argIndex = threeAddressFunction.arguments.findIndex(arg => isEqual(arg, r));
        if (argIndex < targetInfo.registers.functionArgument.length) {
            return undefined;
        }
        return argIndex - targetInfo.registers.functionArgument.length;
    };

    const instructionsWithArgsFromStack: ThreeAddressStatement[] = flatten(
        threeAddressFunction.instructions.map(tas => {
            if (writes(tas).some(r => argumentStackOffset(r) !== undefined)) {
                debug('tried to write to an arg');
            }
            const result: ThreeAddressStatement[] = [];
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
                            why: `Load arg ${from.name} from stack`,
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
                            why: `Load arg from stack`,
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
                            why: `Load arg from stack`,
                        });
                    }
                    result.push({ ...tas, lhs, rhs });
                    break;
                default:
                    if (
                        reads(tas, threeAddressFunction.arguments).some(
                            r => argumentStackOffset(r) !== undefined
                        )
                    ) {
                        throw debug(
                            `not sure how to convert args to stack loads for ${
                                tas.kind
                            }. ${JSON.stringify(tas)}`
                        );
                    }
                    return [tas];
            }
            return result;
        })
    );

    const functonWithArgsFromStack = {
        ...threeAddressFunction,
        instructions: instructionsWithArgsFromStack,
    };

    const { assignment, newFunction: tafWithAssignment } = assignRegisters(
        functonWithArgsFromStack,
        targetInfo.registers.generalPurpose
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
    const statements: TargetStatement<TargetRegister>[] = flatten(
        instructionsWithArgsFromStack.map((instruction, index) =>
            statementToTarget({
                tas: instruction,
                targetInfo,
                functionArguments: threeAddressFunction.arguments,
                registerAssignment: assignment,
                exitLabel,
                stackOffset: stackOffsetPerInstruction[index],
            })
        )
    );

    const usedRegisters = orderedSet<TargetRegister>(operatorCompare);
    Object.values(assignment.registerMap).forEach(usedRegisters.add);

    // Add preamble
    const totalStackSlotsUsed = usedRegisters.size() + stackUsage.length;
    const instructions: TargetStatement<TargetRegister>[] = [];
    let stackSlotIndex = 0;
    instructions.push({
        kind: 'stackReserve',
        words: totalStackSlotsUsed,
        why: `Preamble`,
    });
    instructions.push(
        ...extraSavedRegisters.map(r => {
            const result = {
                kind: 'stackStore' as 'stackStore',
                register: r,
                offset: stackSlotIndex,
                why: 'Preamble: save extra register',
            };
            stackSlotIndex++;
            return result;
        })
    );
    instructions.push(
        ...usedRegisters.toList().map(r => {
            const result = {
                kind: 'stackStore' as 'stackStore',
                register: r,
                offset: stackSlotIndex,
                why: 'Preamble: save used register',
            };
            stackSlotIndex++;
            return result;
        })
    );
    instructions.push(...statements);
    instructions.push({ kind: 'label', name: exitLabel, why: 'cleanup' });

    // Add cleanup
    stackSlotIndex = totalStackSlotsUsed;
    instructions.push(
        ...usedRegisters
            .toList()
            .reverse()
            .map(r => {
                stackSlotIndex--;
                return {
                    kind: 'stackLoad' as 'stackLoad',
                    register: r,
                    offset: stackSlotIndex,
                    why: 'Cleanup: restore used register',
                };
            })
    );
    instructions.push(
        ...extraSavedRegisters.reverse().map(r => {
            stackSlotIndex--;
            return {
                kind: 'stackLoad' as 'stackLoad',
                register: r,
                offset: stackSlotIndex,
                why: 'Cleanup: restore used register',
            };
        })
    );
    instructions.push({
        kind: 'stackRelease',
        words: totalStackSlotsUsed,
        why: `Cleanup: Restore stack pointer`,
    });
    instructions.push(...finalCleanup);
    return { name: threeAddressFunction.name, instructions, stackUsage };
};
