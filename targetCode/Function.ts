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
import { TargetInfo } from '../TargetInfo.js';

type ToTargetInput<TargetRegister> = {
    threeAddressFunction: ThreeAddressFunction;
    targetInfo: TargetInfo<TargetRegister>;
    finalCleanup: TargetStatement<TargetRegister>[];
    isMain: boolean; // Controls whether to save/restore registers
};

export type StackUsage = string[]; // For not just comment. TODO: structured data
export type StackIndexLookup = { [key: string]: number };

const lookup = (index: StackIndexLookup, key: string) => {
    const result = index[key];
    if (result === undefined) debug('bad stack lookup');
    return result;
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
                    const fromLocation = argumentLocation(
                        targetInfo.registers,
                        taf.arguments,
                        tas.from
                    );
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
                    const lhsLocation = argumentLocation(
                        targetInfo.registers,
                        taf.arguments,
                        tas.lhs
                    );
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
                    const rhsLocation = argumentLocation(
                        targetInfo.registers,
                        taf.arguments,
                        tas.rhs
                    );
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
                        const location = argumentLocation(
                            targetInfo.registers,
                            taf.arguments,
                            r
                        );
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
    const stackUsage: StackUsage = [];
    threeAddressFunction.arguments.map((arg, index) => {
        const argLocation = argumentLocation(
            targetInfo.registers,
            threeAddressFunction.arguments,
            arg
        );
        if (argLocation.kind == 'stack') {
            stackUsage.push(`Argument: ${arg.name}`);
        }
    });

    const extraSavedRegisters = isMain ? [] : targetInfo.extraSavedRegisters;

    extraSavedRegisters.forEach(r => {
        stackUsage.push(`Saved extra: ${r}`);
    });

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
        stackUsage.push(`Saved used: ${r}`);
    });

    const stackIndexLookup: StackIndexLookup = {};
    stackUsage.forEach((usage, index) => {
        stackIndexLookup[usage] = index;
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
            })
        )
    );

    return {
        name: threeAddressFunction.name,
        instructions: [
            { kind: 'stackReserve', words: stackUsage.length, why: `Reserve stack` },
            ...extraSavedRegisters.map(r => ({
                kind: 'stackStore' as 'stackStore',
                register: r,
                offset: lookup(stackIndexLookup, `Saved extra: ${r}`),
                why: 'Preamble: save extra register',
            })),
            ...usedSavedRegisters.map(r => ({
                kind: 'stackStore' as 'stackStore',
                register: r,
                offset: lookup(stackIndexLookup, `Saved used: ${r}`),
                why: 'Preamble: save used register',
            })),
            ...statements,
            { kind: 'label', name: exitLabel, why: 'cleanup' },
            ...usedSavedRegisters.map(r => ({
                kind: 'stackLoad' as 'stackLoad',
                register: r,
                offset: lookup(stackIndexLookup, `Saved used: ${r}`),
                why: 'Cleanup: restore used register',
            })),
            ...extraSavedRegisters.map(r => ({
                kind: 'stackLoad' as 'stackLoad',
                register: r,
                offset: lookup(stackIndexLookup, `Saved extra: ${r}`),
                why: 'Cleanup: restore extra register',
            })),
            { kind: 'stackRelease', words: stackUsage.length, why: `Restore stack` },
            ...finalCleanup,
        ],
        stackUsage,
    };
};
