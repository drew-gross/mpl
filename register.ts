import ComparisonResult from './util/comparisonResult.js';
import compareString from './string/compare.js';
import compareInteger from './integer/compare.js';

export type Argument = { argIndex: number };
export type Register = 'result' | { name: string } | Argument;

export const isEqual = (lhs: Register, rhs: Register): boolean => {
    if (typeof lhs == 'string' && typeof rhs == 'string') {
        return lhs == rhs;
    } else if (typeof lhs != 'string' && 'argIndex' in lhs && typeof rhs != 'string' && 'argIndex' in rhs) {
        return lhs.argIndex == rhs.argIndex;
    } else if (typeof lhs != 'string' && 'name' in lhs && typeof rhs != 'string' && 'name' in rhs) {
        return lhs.name == (rhs as any).name;
    } else {
        return false;
    }
};

export const compare = (lhs: Register, rhs: Register): ComparisonResult => {
    if (typeof lhs == 'string' && typeof rhs == 'string') {
        return compareString(lhs, rhs);
    } else if ('argIndex' in (lhs as any) && 'argIndex' in (rhs as any)) {
        return compareInteger((lhs as any).argIndex, (rhs as any).argIndex);
    } else if ('name' in (lhs as any) && 'name' in (rhs as any)) {
        return compareString((lhs as any).name, (rhs as any).name);
    } else if (typeof lhs == 'string') {
        // Now we know they are different types. Declare strings less than normal registers less that arguments.
        return ComparisonResult.LT;
    } else if (typeof rhs == 'string') {
        return ComparisonResult.GT;
    } else if ('argIndex' in lhs) {
        return ComparisonResult.GT;
    } else if ('argIndex' in rhs) {
        return ComparisonResult.LT;
    } else if ('name' in lhs) {
        return ComparisonResult.LT;
    } else {
        return ComparisonResult.GT;
    }
};

export const toString = (r: Register): string => {
    if (typeof r == 'string') {
        return `$${r}`;
    }
    if ('argIndex' in r) {
        return `arg${r.argIndex}`;
    }
    return `r:${r.name}`;
};
