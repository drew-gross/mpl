import idAppender from '../util/idAppender.js';
import { Statement as ThreeAddressStatement, reads } from '../threeAddressCode/Statement.js';
import { Function as ThreeAddressFunction } from '../threeAddressCode/Function';
import { Register } from '../register.js';
import { assignRegisters } from '../controlFlowGraph.js';
import debug from '../util/debug.js';
import { orderedSet, operatorCompare } from '../util/ordered-set.js';
import flatten from '../util/list/flatten.js';
import {
    Statement as TargetStatement,
    toTarget as statementToTarget,
    argumentLocation,
} from './Statement.js';
import { StackUsage } from './StackUsage.js';
import { TargetInfo } from '../TargetInfo.js';

type ToTargetInput<TargetRegister> = {
    threeAddressFunction: ThreeAddressFunction;
    targetInfo: TargetInfo<TargetRegister>;
    finalCleanup: TargetStatement<TargetRegister>[];
    isMain: boolean; // Controls whether to save/restore registers
};

const savedExtraOffset = (usage: StackUsage, saved: string): number => {
    const offsetInSaved = usage.savedExtraRegisters.findIndex(s => s == saved);
    if (offsetInSaved < 0) debug('no find');
    return usage.arguments.length + offsetInSaved;
};

const savedUsedOffset = (usage: StackUsage, saved: string): number => {
    const offsetInUsed = usage.savedUsedRegisters.findIndex(s => s == saved);
    if (offsetInUsed < 0) debug('no find');
    return usage.arguments.length + usage.savedExtraRegisters.length + offsetInUsed;
};

const calleeReserveCount = (usage: StackUsage): number => {
    return (
        usage.arguments.length +
        usage.savedExtraRegisters.length +
        usage.savedUsedRegisters.length
    );
};

export type Function<TargetRegister> = {
    name: string;
    instructions: TargetStatement<TargetRegister>[];
    stackUsage: StackUsage;
};

const translateStackArgumentsToStackReads = (
    taf: ThreeAddressFunction,
    targetInfo
): ThreeAddressFunction => {
    const temporaryNameMaker = idAppender();
    const makeTemporary = name => ({ name: temporaryNameMaker(name) });
    const instructions = flatten(
        taf.instructions.map(tas => {
            const result: ThreeAddressStatement[] = [];
            switch (tas.kind) {
                case 'move':
                    let from = tas.from;
                    const fromLocation = argumentLocation(targetInfo, taf.arguments, tas.from);
                    if (fromLocation.kind == 'stack') {
                        from = makeTemporary(`load_arg_${from.name}`);
                        if (!from) debug('!from');
                        // TODO: Just load directly from the stack to the dest
                        result.push({
                            kind: 'unspill',
                            register: from,
                            offset: fromLocation.offset,
                            why: `Load arg ${from.name} from stack`,
                        });
                    }
                    result.push({ ...tas, from });
                    break;
                case 'add':
                    let lhs = tas.lhs;
                    const lhsLocation = argumentLocation(targetInfo, taf.arguments, tas.lhs);
                    if (lhsLocation.kind == 'stack') {
                        // TODO: Can probably do this without an extra temp register
                        lhs = makeTemporary(`load_arg_${lhs.name}`);
                        result.push({
                            kind: 'unspill',
                            register: lhs,
                            offset: lhsLocation.offset,
                            why: `Load arg from stack`,
                        });
                    }
                    let rhs = tas.rhs;
                    const rhsLocation = argumentLocation(targetInfo, taf.arguments, tas.rhs);
                    if (rhsLocation.kind == 'stack') {
                        rhs = makeTemporary(`load_arg_${rhs.name}`);
                        result.push({
                            kind: 'unspill',
                            register: rhs,
                            offset: rhsLocation.offset,
                            why: `Load arg from stack`,
                        });
                    }
                    result.push({ ...tas, lhs, rhs });
                    break;
                default:
                    const registersRead = reads(tas, taf.arguments);
                    const registerReadsStackArgument = (r: Register) => {
                        const location = argumentLocation(targetInfo, taf.arguments, r);
                        return location.kind == 'stack';
                    };
                    if (registersRead.some(registerReadsStackArgument)) {
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
    return { ...taf, instructions };
};

export const toTarget = <TargetRegister>({
    threeAddressFunction,
    targetInfo,
    finalCleanup,
    isMain,
}: ToTargetInput<TargetRegister>): Function<TargetRegister> => {
    const stackUsage: StackUsage = {
        arguments: [],
        savedExtraRegisters: [],
        savedUsedRegisters: [],
        callerSavedRegisters: [],
    };

    targetInfo.callerSavedRegisters.forEach(r => {
        stackUsage.callerSavedRegisters.push(r);
    });

    threeAddressFunction.arguments.map((arg, index) => {
        if (argumentLocation(targetInfo, threeAddressFunction.arguments, arg).kind == 'stack') {
            stackUsage.arguments.push(`Argument: ${arg.name}`);
        }
    });

    // TODO: on x64, call instruction implicitly pushes to the stack, we need to adjust for that

    const extraSavedRegisters = isMain ? [] : targetInfo.extraSavedRegisters;

    extraSavedRegisters.forEach(r => {
        stackUsage.savedExtraRegisters.push(`Saved extra: ${r}`);
    });

    // When we call this we don't know the total stack frame size because we haven't assigned registers yet. statmentToTarget takes into account the total stack frame size and adjusts stack indexes accordingly.
    const functonWithArgsFromStack = translateStackArgumentsToStackReads(
        threeAddressFunction,
        targetInfo
    );

    const { assignment, newFunction: functionWithAssignment } = assignRegisters(
        functonWithArgsFromStack,
        targetInfo.registers.generalPurpose
    );

    const usedSavedRegistersSet = orderedSet<TargetRegister>(operatorCompare);
    if (!isMain) {
        Object.values(assignment.registerMap).forEach(usedSavedRegistersSet.add);
    }
    const usedSavedRegisters = usedSavedRegistersSet.toList();

    usedSavedRegisters.forEach(r => {
        stackUsage.savedUsedRegisters.push(`Saved used: ${r}`);
    });

    const stackOffsetPerInstruction: number[] = [];
    functionWithAssignment.instructions.forEach(i => {
        if (i.kind == 'alloca') {
            stackOffsetPerInstruction.push(i.bytes);
        } else {
            stackOffsetPerInstruction.push(0);
        }
    });

    const exitLabel = `${threeAddressFunction.name}_cleanup`;
    const statements: TargetStatement<TargetRegister>[] = flatten(
        functonWithArgsFromStack.instructions.map((instruction, index) =>
            statementToTarget({
                tas: instruction,
                targetInfo,
                functionArguments: threeAddressFunction.arguments,
                registerAssignment: assignment,
                exitLabel,
                stackOffset: stackOffsetPerInstruction[index],
                stackFrameSize: calleeReserveCount(stackUsage),
            })
        )
    );

    return {
        name: threeAddressFunction.name,
        instructions: [
            {
                kind: 'stackReserve',
                words: calleeReserveCount(stackUsage),
                why: `Reserve stack`,
            },
            ...extraSavedRegisters.map(r => ({
                kind: 'stackStore' as 'stackStore',
                register: r,
                offset: savedExtraOffset(stackUsage, `Saved extra: ${r}`),
                why: 'Preamble: save extra register',
            })),
            ...usedSavedRegisters.map(r => ({
                kind: 'stackStore' as 'stackStore',
                register: r,
                offset: savedUsedOffset(stackUsage, `Saved used: ${r}`),
                why: 'Preamble: save used register',
            })),
            ...statements,
            { kind: 'label', name: exitLabel, why: 'cleanup' },
            ...usedSavedRegisters.map(r => ({
                kind: 'stackLoad' as 'stackLoad',
                register: r,
                offset: savedUsedOffset(stackUsage, `Saved used: ${r}`),
                why: 'Cleanup: restore used register',
            })),
            ...extraSavedRegisters.map(r => ({
                kind: 'stackLoad' as 'stackLoad',
                register: r,
                offset: savedExtraOffset(stackUsage, `Saved extra: ${r}`),
                why: 'Cleanup: restore extra register',
            })),
            {
                kind: 'stackRelease',
                words: calleeReserveCount(stackUsage),
                why: `Restore stack`,
            },
            ...finalCleanup,
        ],
        stackUsage,
    };
};
