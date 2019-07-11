import ComparisonResult from './util/comparisonResult.js';
import compareString from './string/compare.js';

export const specialRegisterNames = ['arg1', 'arg2', 'arg3', 'result'];

export type Register = 'arg1' | 'arg2' | 'arg3' | 'result' | { name: string };

export const isEqual = (lhs: Register, rhs: Register): boolean => {
    if (typeof lhs == 'string' && typeof rhs == 'string') {
        return lhs == rhs;
    } else if (typeof lhs == 'object' && typeof rhs == 'object') {
        return lhs.name == rhs.name;
    } else {
        return false;
    }
};

export const compare = (lhs: Register, rhs: Register): ComparisonResult => {
    if (typeof lhs == 'string' && typeof rhs == 'string') {
        return compareString(lhs, rhs);
    } else if (typeof lhs == 'string') {
        // declare strings less than objects
        return ComparisonResult.LT;
    } else if (typeof rhs == 'string') {
        return ComparisonResult.GT;
    } else {
        return compareString(lhs.name, rhs.name);
    }
};

export const toString = (r: Register): string => {
    if (typeof r == 'string') {
        return `$${r}`;
    }
    return `r:${r.name}`;
};
