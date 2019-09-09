import { UninferredStatement, Statement } from './ast.js';
import { TargetInfo } from './threeAddressCode/generator.js';
import { Type, TypeDeclaration } from './types.js';
import { FileResult } from 'fs-extra';
import { ThreeAddressProgram } from './threeAddressCode/generator.js';

export type VariableLocation = 'Global' | 'Parameter' | 'Stack';
export type VariableDeclaration = {
    name: string;
    type: Type;
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
    program: Function;
    globalDeclarations: VariableDeclaration[];
    stringLiterals: StringLiteralData[];
};
export type ExecutionResult =
    | {
          exitCode: number;
          stdout: string;
      }
    | {
          error: string;
      };

export type CompilationResult =
    | {
          sourceFile: FileResult;
          binaryFile: FileResult;
          threeAddressCodeFile: FileResult | undefined;
          debugInstructions: string;
      }
    | { error: string; intermediateFile?: FileResult };

export type Backend = {
    name: string;
    compile: (input: FrontendOutput) => Promise<CompilationResult | { error: string }>;
    compileTac?: (input: ThreeAddressProgram) => Promise<CompilationResult | { error: string }>;
    targetInfo?: TargetInfo;
    execute: (exePath: string, stdinPath: string) => Promise<ExecutionResult>;
};
