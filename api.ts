import { UninferredStatement, Statement } from './ast';
import { RegisterAgnosticTargetInfo } from './TargetInfo';
import { Type, TypeDeclaration } from './types';
import { FileResult } from 'fs-extra';
import { Program } from './threeAddressCode/Program';

export type VariableLocation = 'Global' | 'Parameter' | 'Stack';
export type VariableDeclaration = {
    name: string;
    type: Type;
    exported: boolean;
};
export type UninferredFunction = {
    // TODO: Don't export this (or rethink it)
    name: string;
    statements: UninferredStatement[];
    variables: VariableDeclaration[];
    parameters: VariableDeclaration[];
};
export type Function = {
    name: string;
    statements: Statement[];
    variables: VariableDeclaration[];
    parameters: VariableDeclaration[];
    returnType: Type;
};
export type StringLiteralData = { id: number; value: string };
export type FrontendOutput = {
    types: TypeDeclaration[];
    functions: Function[];
    builtinFunctions: VariableDeclaration[];
    program: Function | string[]; // string list is names of exported variables. TODO: better name
    globalDeclarations: VariableDeclaration[];
    stringLiterals: StringLiteralData[];
};
export type ExecutionResult =
    | {
          exitCode: number;
          stdout: string;
          executorName: string;
          runInstructions: string;
          debugInstructions: string;
      }
    | { error: string; executorName: string };

export type Assembly = {};

export type CompilationResult =
    | {
          source: string;
          sourceFile: FileResult;
          binaryFile: FileResult;
          threeAddressCode?: Assembly;
          threeAddressCodeFile: FileResult | undefined;
      }
    | { error: string; intermediateFile?: FileResult };

export type Executor = {
    name: string;
    execute: (exePath: string, stdinPath: string) => Promise<ExecutionResult>;
};

export type Backend = {
    name: string;
    compile: (
        input: FrontendOutput
    ) => { target: string; tac: Program | undefined } | { error: string };
    compileTac?: (input: Program, includeLeakCheck: boolean) => string | { error: string };
    finishCompilation: (
        input: string,
        tac: Program | undefined
    ) => Promise<CompilationResult | { error: string }>;
    targetInfo?: RegisterAgnosticTargetInfo;
    executors: Executor[];
};
