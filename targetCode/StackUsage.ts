import debug from '../util/debug.js';
import join from '../util/join.js';
import { Register, toString, isEqual } from '../register.js';

// Order here matches argument on stack
export type StackUsage<TargetRegister> = {
    callerSavedRegisters: string[];
    arguments: Register[];
    spills: Register[];
    savedExtraRegisters: TargetRegister[];
    savedUsedRegisters: TargetRegister[];
};

export const stackUsageToString = <TargetRegister>(
    usage: StackUsage<TargetRegister>
): string => {
    const descriptions: string[] = [
        ...usage.callerSavedRegisters,
        ...usage.arguments.map(toString),
        ...((usage.savedExtraRegisters as unknown) as string[]),
        ...((usage.savedUsedRegisters as unknown) as string[]),
        ...usage.spills.map(toString),
    ];
    return `[${join(descriptions, ', ')}]`;
};

export const offset = <TargetRegister>(
    usage: StackUsage<TargetRegister>,
    register: Register
): number => {
    const argIndex = usage.arguments.findIndex(r => isEqual(register, r));
    if (argIndex >= 0) {
        return calleeReserveCount(usage) - argIndex;
    }
    const spillIndex = usage.spills.findIndex(r => isEqual(register, r));
    if (spillIndex >= 0) {
        return spillIndex;
    }
    throw debug('not an argument or spill');
};

export const savedExtraOffset = <TargetRegister>(
    usage: StackUsage<TargetRegister>,
    saved: TargetRegister
): number => {
    const offsetInSaved = usage.savedExtraRegisters.findIndex(s => s == saved);
    if (offsetInSaved < 0) debug('no find');
    return usage.arguments.length + offsetInSaved;
};

export const savedUsedOffset = <TargetRegister>(
    usage: StackUsage<TargetRegister>,
    saved: TargetRegister
): number => {
    const offsetInUsed = usage.savedUsedRegisters.findIndex(s => s == saved);
    if (offsetInUsed < 0) debug('no find');
    return usage.arguments.length + usage.savedExtraRegisters.length + offsetInUsed;
};

export const calleeReserveCount = <TargetRegister>(usage: StackUsage<TargetRegister>): number =>
    usage.arguments.length +
    usage.savedExtraRegisters.length +
    usage.savedUsedRegisters.length +
    usage.spills.length;
