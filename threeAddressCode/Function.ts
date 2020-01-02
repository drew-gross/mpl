import { Register } from './Register.js';
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
            `(function) ${name}(${join(
                args.map(arg => arg.toString()),
                ', '
            )}):`,
            ...instructions.map(statementToString),
        ],
        '\n'
    );
};
