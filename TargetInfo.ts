import { Statement } from './targetCode/Statement';
import { Function } from './threeAddressCode/Function';

// These functions tend to have platform specific implementations. Put your platforms implementation here.
export type TargetFunctionImpls = {
    mallocImpl: Function;
    printImpl: Function;
    readIntImpl: Function;
};

export type RegisterAgnosticTargetInfo = {
    functionImpls: TargetFunctionImpls;
    bytesInWord: number;
    syscallNumbers: any;
};

export type TargetRegisters<TargetRegister> = {
    generalPurpose: TargetRegister[];
    functionArgument: TargetRegister[];
    functionResult: TargetRegister;
    syscallArgument: TargetRegister[];
    syscallSelectAndResult: TargetRegister;
};

// A function that turns target code in to an assembly string
export type ExeTranslator<TargetRegister> = (tas: Statement<TargetRegister>) => string[];

export type TargetInfo<TargetRegister> = {
    registerAgnosticInfo: RegisterAgnosticTargetInfo;
    registers: TargetRegisters<TargetRegister>;
    extraSavedRegisters: TargetRegister[];
    callerSavedRegisters: string[];
    registersClobberedBySyscall: TargetRegister[];
    translator: ExeTranslator<TargetRegister>;
};
