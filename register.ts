export const specialRegisterNames = ['functionArgument1', 'functionArgument2', 'functionArgument3', 'functionResult'];

export type Register =
    | 'functionArgument1'
    | 'functionArgument2'
    | 'functionArgument3'
    | 'functionResult'
    | { name: string };

export const isEqual = (lhs: Register, rhs: Register): boolean => {
    if (typeof lhs == 'string' && typeof rhs == 'string') {
        return lhs == rhs;
    } else if (typeof lhs == 'object' && typeof rhs == 'object') {
        return lhs.name == rhs.name;
    } else {
        return false;
    }
};

export const toString = (r: Register): string => {
    if (typeof r == 'string') {
        return `r:${r}`;
    }
    return `r:${r.name}`;
};
