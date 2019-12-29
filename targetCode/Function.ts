import idAppender from '../util/idAppender.js';
import uniqueCmp from '../util/list/uniqueCmp.js';
import { Statement as ThreeAddressStatement, reads } from '../threeAddressCode/Statement.js';
import { Function as ThreeAddressFunction } from '../threeAddressCode/Function';
import { Register, isEqual } from '../register.js';
import { assignRegisters } from '../controlFlowGraph.js';
import debug from '../util/debug.js';
import { orderedSet, operatorCompare } from '../util/ordered-set.js';
import flatten from '../util/list/flatten.js';
import {
    Statement as TargetStatement,
    toTarget as statementToTarget,
    argumentLocation,
} from './Statement.js';
import {
    StackUsage,
    calleeReserveCount,
    savedExtraOffset,
    savedUsedOffset,
} from './StackUsage.js';
import { TargetInfo } from '../TargetInfo.js';

type ToTargetInput<TargetRegister> = {
    threeAddressFunction: ThreeAddressFunction;
    targetInfo: TargetInfo<TargetRegister>;
    finalCleanup: TargetStatement<TargetRegister>[];
    isMain: boolean; // Controls whether to save/restore registers
};

export type Function<TargetRegister> = {
    name: string;
    instructions: TargetStatement<TargetRegister>[];
    stackUsage: StackUsage<TargetRegister>;
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

const spilledRegisters = (threeAddressFunction: ThreeAddressFunction): Register[] =>
    uniqueCmp(
        isEqual,
        threeAddressFunction.instructions
            .filter(i => ['spill', 'unspill'].includes(i.kind))
            .map((i: any) => i.register)
    );

const stackArguments = <TargetRegister>(
    targetInfo: TargetInfo<TargetRegister>,
    threeAddressFunction: ThreeAddressFunction
): Register[] =>
    threeAddressFunction.arguments.filter(
        arg => argumentLocation(targetInfo, threeAddressFunction.arguments, arg).kind == 'stack'
    );

export const toTarget = <TargetRegister>({
    threeAddressFunction,
    targetInfo,
    finalCleanup,
    isMain,
}: ToTargetInput<TargetRegister>): Function<TargetRegister> => {
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

    const stackUsage: StackUsage<TargetRegister> = {
        arguments: stackArguments(targetInfo, threeAddressFunction),
        spills: spilledRegisters(functionWithAssignment),
        savedExtraRegisters: isMain ? [] : targetInfo.extraSavedRegisters,
        savedUsedRegisters: usedSavedRegistersSet.toList(),
        callerSavedRegisters: targetInfo.callerSavedRegisters,
    };

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
                stackUsage,
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
            ...stackUsage.savedExtraRegisters.map(r => ({
                kind: 'stackStore' as 'stackStore',
                register: r,
                offset: savedExtraOffset(stackUsage, r),
                why: 'Preamble: save extra register',
            })),
            ...stackUsage.savedUsedRegisters.map(r => ({
                kind: 'stackStore' as 'stackStore',
                register: r,
                offset: savedUsedOffset(stackUsage, r),
                why: 'Preamble: save used register',
            })),
            ...statements,
            { kind: 'label', name: exitLabel, why: 'cleanup' },
            ...stackUsage.savedUsedRegisters.map(r => ({
                kind: 'stackLoad' as 'stackLoad',
                register: r,
                offset: savedUsedOffset(stackUsage, r),
                why: 'Cleanup: restore used register',
            })),
            ...stackUsage.savedExtraRegisters.map(r => ({
                kind: 'stackLoad' as 'stackLoad',
                register: r,
                offset: savedExtraOffset(stackUsage, r),
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
