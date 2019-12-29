import join from '../util/join.js';

// Order here matches argument on stack
export type StackUsage = {
    callerSavedRegisters: string[];
    arguments: string[];
    savedExtraRegisters: string[];
    savedUsedRegisters: string[];
};

export const stackUsageToString = (usage: StackUsage): string => {
    const descriptions: string[] = [];
    usage.callerSavedRegisters.forEach(r => {
        descriptions.push(r);
    });
    usage.arguments.forEach(r => {
        descriptions.push(r);
    });
    usage.savedExtraRegisters.forEach(r => {
        descriptions.push(r);
    });
    usage.savedUsedRegisters.forEach(r => {
        descriptions.push(r);
    });
    return `[${join(descriptions, ', ')}]`;
};
