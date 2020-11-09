import { Statement as ThreeAddressStatement, reads } from '../threeAddressCode/Statement';
import {
    Function as ThreeAddressFunction,
    toString as functionToString,
} from '../threeAddressCode/Function';
import { Register } from '../threeAddressCode/Register';
import { assignRegisters } from '../controlFlowGraph';
import debug from '../util/debug';
import { orderedSet, operatorCompare } from '../util/ordered-set';
import flatten from '../util/list/flatten';
import {
    Statement as TargetStatement,
    toTarget as statementToTarget,
    argumentStackLocation,
} from './Statement';
import { StackUsage, calleeReserveCount, savedExtraOffset, savedUsedOffset } from './StackUsage';
import { TargetInfo } from '../TargetInfo';

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

// TODO: this code is very similar to "moveRegisterToStack" in controlFlowGraph.js, try to DRY this up
const translateStackArgumentsToStackReads = (
    taf: ThreeAddressFunction,
    targetInfo
): ThreeAddressFunction => {
    // TODO: don't load the argument if it happens to already be loaded due to a previous loadStack
    const instructions = flatten(
        taf.instructions.map(tas => {
            const result: ThreeAddressStatement[] = [];
            // If this register is an argument is on the stack, generate a new register to load into temporarily
            switch (tas.kind) {
                case 'move':
                    // TODO: just load directly into the destination
                    const location = argumentStackLocation(targetInfo, taf.arguments, tas.from);
                    if (location) {
                        const fromLoaded = new Register(`${tas.from.name}_loaded`);
                        result.push({
                            kind: 'loadStack',
                            register: fromLoaded,
                            location,
                            why: `Load arg ${tas.from.name} from stack`,
                        });
                        result.push({ ...tas, from: fromLoaded });
                    } else {
                        result.push(tas);
                    }
                    break;
                case 'add':
                    const lhsLocation = argumentStackLocation(
                        targetInfo,
                        taf.arguments,
                        tas.lhs
                    );
                    let lhsLoaded = tas.lhs;
                    if (lhsLocation) {
                        lhsLoaded = new Register(`${tas.lhs.name}_loaded`);
                        result.push({
                            kind: 'loadStack',
                            register: lhsLoaded,
                            location: lhsLocation,
                            why: `Load arg from stack`,
                        });
                    }
                    let rhsLoaded = tas.rhs;
                    const rhsLocation = argumentStackLocation(
                        targetInfo,
                        taf.arguments,
                        tas.rhs
                    );
                    if (rhsLocation) {
                        rhsLoaded = new Register(`${tas.rhs.name}_loaded`);
                        result.push({
                            kind: 'loadStack',
                            register: rhsLoaded,
                            location: rhsLocation,
                            why: `Load arg from stack`,
                        });
                    }
                    result.push({ ...tas, lhs: lhsLoaded, rhs: rhsLoaded });
                    break;
                default:
                    const registersRead = reads(tas, taf.arguments);
                    const registerReadsStackArgument = (r: Register) =>
                        argumentStackLocation(targetInfo, taf.arguments, r) !== undefined;
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

const spillSlotCount = (threeAddressFunction: ThreeAddressFunction): number =>
    Math.max(
        0,
        ...threeAddressFunction.instructions
            .filter(i => ['storeStack', 'loadStack'].includes(i.kind))
            .filter((i: any) => 'slotNumber' in i.location)
            .map((i: any) => i.location.slotNumber)
    );

const stackArguments = <TargetRegister>(
    targetInfo: TargetInfo<TargetRegister>,
    threeAddressFunction: ThreeAddressFunction
): Register[] =>
    threeAddressFunction.arguments.filter(
        arg =>
            argumentStackLocation(targetInfo, threeAddressFunction.arguments, arg) !== undefined
    );

export const toTarget = <TargetRegister>({
    threeAddressFunction,
    targetInfo,
    finalCleanup,
    isMain,
}: ToTargetInput<TargetRegister>): Function<TargetRegister> => {
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
        spillSlotCount: spillSlotCount(functionWithAssignment),
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
    functionToString; // tslint:disable-line
    const exitLabel = `${threeAddressFunction.name}_cleanup`;
    const statements: TargetStatement<TargetRegister>[] = flatten(
        functionWithAssignment.instructions.map((instruction, index) =>
            statementToTarget({
                tas: instruction,
                targetInfo,
                functionArguments: threeAddressFunction.arguments,
                registerAssignment: assignment,
                exitLabel,
                stackOffset: stackOffsetPerInstruction[index],
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
