import statementToString from './statementToString.js';
import { ThreeAddressProgram, ThreeAddressFunction } from './generator.js';
import join from '../util/join.js';

export const functionToString = ({ name, instructions }: ThreeAddressFunction): string =>
    join([`(function) ${name}:`, ...instructions.map(statementToString)], '\n');

export const programToString = ({ globals, functions, main }: ThreeAddressProgram): string => {
    const globalStrings = Object.keys(globals).map(
        originalName => `(global) ${originalName}: ${globals[originalName].mangledName} ${globals[originalName].bytes}`
    );
    const mainStr = main
        ? `
(function) main:
${join(main.map(statementToString), '\n')}`
        : '';
    return `
${join(globalStrings, '\n')}
${join(functions.map(functionToString), '\n')}
(function) main:
${mainStr}`;
};
