import ComparisonResult from '../util/comparisonResult';
import compareString from '../string/compare';
import debug from '../util/debug';

export class Register {
    public name: string;
    constructor(name: string) {
        this.name = name;
    }
    public toString() {
        throw debug('deprecated');
    }
}
export const toString = (r: Register) => {
    return `r:${r.name}`;
};

export const isEqual = (lhs: Register, rhs: Register): boolean => lhs.name == rhs.name;
export const compare = (lhs: Register, rhs: Register): ComparisonResult =>
    compareString(lhs.name, rhs.name);
