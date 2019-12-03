import { StringLiteralData } from '../api.js';
import { toString as statementToString } from './statement.js';
import { Function, toString as functionToString } from './Function.js';
import debug from '../util/debug.js';
import join from '../util/join.js';

export type Program = {
    globals: { [key: string]: { mangledName: string; bytes: number } };
    functions: Function[];
    main: Function | undefined; // TODO: make this not optional?
    stringLiterals: StringLiteralData[];
};

export const toString = ({ globals, functions, main }: Program): string => {
    const globalStrings = Object.keys(globals).map(
        originalName =>
            `(global) ${originalName}: ${globals[originalName].mangledName} ${globals[originalName].bytes}`
    );
    let mainStr = '';
    if (main) {
        mainStr = functionToString(main);
    }
    return `
${join(globalStrings, '\n\n')}
${mainStr}

${join(functions.map(functionToString), '\n\n')}
`;
};
