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
        // In x64, we add stack arguments on top of where the return address will endup. For some reason, x64 call instruction seems to push 2 words onto the stack, but we only need to offset by one. So I added a dummy value to the "caller saved registers" item and then divide the length by 2 here. It's super jank. TODO: Just use the normal calling convention with the return address on top of the stack arguments https://eli.thegreenplace.net/2011/09/06/stack-frame-layout-on-x86-64
        const offsetForImplicitReturnAddress = usage.callerSavedRegisters.length / 2;
        return calleeReserveCount(usage) - argIndex - offsetForImplicitReturnAddress;
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
