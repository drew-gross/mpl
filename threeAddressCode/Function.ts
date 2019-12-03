import { toString as rToS, Register } from '../register.js';
import { toString as statementToString, Statement } from './Statement.js';
import { filter, FilterPredicate } from '../util/list/filter.js';
import join from '../util/join.js';
import debug from '../util/debug.js';

export type Function = {
    instructions: Statement[];
    arguments: Register[];
    liveAtExit: Register[];
    spills: number;
    name: string;
};

export const toString = ({ name, instructions, arguments: args }: Function): string => {
    if (!args) debug('no args');
    return join(
        [
            `(function) ${name}(${join(args.map(toString), ', ')}):`,
            ...instructions.map(statementToString),
        ],
        '\n'
    );
};

const syscallArgToString = (regOrNumber: number | Register): string => {
    if (typeof regOrNumber == 'number') {
        return regOrNumber.toString();
    } else {
        return rToS(regOrNumber);
    }
};
