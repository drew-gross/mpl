import { ThreeAddressProgram } from './generator.js';

export default (input: string): ThreeAddressProgram => {
    return { globalNameMap: {}, functions: [] };
};
