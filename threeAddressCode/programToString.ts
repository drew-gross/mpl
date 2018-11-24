import statementToString from './statementToString.js';
import { ThreeAddressProgram } from './generator.js';
import join from '../util/join.js';

export default ({ globals, functions, main }: ThreeAddressProgram): string => {
    const globalStrings = Object.keys(globals).map(
        originalName => `(global) ${originalName}: ${globals[originalName].mangledName} ${globals[originalName].bytes}`
    );
    const functionStrings = functions.map(({ name, instructions }) => {
        return join([`(function) ${name}:`, ...instructions.map(statementToString)], '\n');
    });
    const mainStr = main
        ? `
(function) main:
${join(main.map(statementToString), '\n')}`
        : '';
    return `
${join(globalStrings, '\n')}
${join(functionStrings, '\n')}
(function) main:
${mainStr}`;
};
