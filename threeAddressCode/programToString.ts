import { ThreeAddressProgram } from './generator.js';
import join from '../util/join.js';

export default ({ globals, functions }: ThreeAddressProgram): string => {
    const globalStrings = Object.keys(globals).map(
        originalName => `${originalName}: ${globals[originalName].mangledName} ${globals[originalName].bytes}`
    );
    return `
globals:
${join(globalStrings, '\n')}
`;
};
