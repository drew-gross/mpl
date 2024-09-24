import { Statement } from './ast';
import { Statement as PreFunctionExtractionStatement } from './postFunctionExtractionAst';
import { RegisterAgnosticTargetInfo } from './TargetInfo';
import { Type, TypeDeclaration, TypeReference } from './types';
import { FileResult } from 'fs-extra';
import { Program } from './threeAddressCode/Program';

export type Variable = {
    name: string;
    type: Type | TypeReference;
    exported: boolean;
};
export type PreFunctionExtractionFunction = {
    statements: PreFunctionExtractionStatement[];
    // TODO: These should probably belong to each statement?
    variables: Variable[];
    parameters: Variable[];
};
export type Function = {
    statements: Statement[];
    variables: Variable[];
    parameters: Variable[];
    returnType: Type;
};

export const getTypeOfFunction = (fn: Function): Type => {
    return {
        type: {
            kind: 'Function',
            permissions: [],
            arguments: fn.parameters.map(p => p.type),
            returnType: fn.returnType,
        },
        methods: [],
    };
};

export type StringLiteralData = { id: number; value: string };
export type ExportedVariable = {
    exportedName: string;
    declaredName: string;
};
export type FrontendOutput = {
    types: TypeDeclaration[];
    functions: Map<string, Function>;
    builtinFunctions: Variable[];
    program: Function | ExportedVariable[];
    globalDeclarations: Variable[];
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
