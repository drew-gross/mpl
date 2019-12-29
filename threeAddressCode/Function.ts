import { toString as rToS, Register } from '../register.js';
import { toString as statementToString, Statement } from './Statement.js';
import join from '../util/join.js';
import debug from '../util/debug.js';

export type Function = {
    instructions: Statement[];
    arguments: Register[];
    liveAtExit: Register[];
    name: string;
};

export const toString = ({ name, instructions, arguments: args }: Function): string => {
    if (!args) debug('no args');
    return join(
        [
            `(function) ${name}(${join(args.map(rToS), ', ')}):`,
            ...instructions.map(statementToString),
        ],
        '\n'
    );
};
