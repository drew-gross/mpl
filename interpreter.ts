import { Program } from './threeAddressCode/Program';

export type InterpreterResults = {
    exitCode: number;
};

export const interpret = (_: Program): InterpreterResults => {
    return { exitCode: 0 };
};
