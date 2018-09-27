import statementToString from './statementToString.js';
import { ThreeAddressProgram } from './generator.js';
import join from '../util/join.js';

export default ({ globals, functions }: ThreeAddressProgram): string => {
    const globalStrings = Object.keys(globals).map(
        originalName => `(global) ${originalName}: ${globals[originalName].mangledName} ${globals[originalName].bytes}`
    );
    const functionStrings = functions.map(({ name, isMain, instructions }) => {
        return join([`(function) ${isMain ? 'main' : name}:`, ...instructions.map(statementToString)], '\n');
    });
    return `
${join(globalStrings, '\n')}
${join(functionStrings, '\n')}
`;
};
