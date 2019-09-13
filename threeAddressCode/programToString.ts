import { toString as statementToString } from './statement.js';
import { ThreeAddressProgram, ThreeAddressFunction } from './generator.js';
import { toString } from '../register.js';
import join from '../util/join.js';

export const functionToString = ({ name, instructions, arguments: args }: ThreeAddressFunction): string =>
    join([`(function) ${name}(${join(args.map(toString), ', ')}):`, ...instructions.map(statementToString)], '\n');

export const programToString = ({ globals, functions, main }: ThreeAddressProgram): string => {
    const globalStrings = Object.keys(globals).map(
        originalName => `(global) ${originalName}: ${globals[originalName].mangledName} ${globals[originalName].bytes}`
    );
    let mainStr = '';
    if (main) {
        mainStr = `(function) main():\n${join(main.map(statementToString), '\n')}`;
    }
    return `
${join(globalStrings, '\n\n')}
${join(functions.map(functionToString), '\n\n')}
${mainStr}`;
};
