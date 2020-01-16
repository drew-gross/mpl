import { Register } from './Register';
import { toString as statementToString, Statement } from './Statement';
import join from '../util/join';
import debug from '../util/debug';

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
