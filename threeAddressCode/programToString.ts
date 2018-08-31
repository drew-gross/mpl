import { ThreeAddressProgram } from './generator.js';
import join from '../util/join.js';

export default ({ globalNameMap, functions }: ThreeAddressProgram): string => {
    const globals = Object.keys(globalNameMap);
    return `
globals:
${join(globals, '\n')}
`;
};
