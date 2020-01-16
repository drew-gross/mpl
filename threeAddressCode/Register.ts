import ComparisonResult from '../util/comparisonResult';
import compareString from '../string/compare';

export class Register {
    public name: string;
    constructor(name: string) {
        this.name = name;
    }

    public toString() {
        return `r:${this.name}`;
    }
}

export const isEqual = (lhs: Register, rhs: Register): boolean => lhs.name == rhs.name;
export const compare = (lhs: Register, rhs: Register): ComparisonResult =>
    compareString(lhs.name, rhs.name);
