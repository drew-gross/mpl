import { LoweredAst, UninferredStatement } from './ast.js';

export type Type =
    | {
          name: 'String' | 'Integer' | 'Boolean';
      }
    | {
          name: 'Function';
          arg: { type: Type };
      };
export type TypeError = string;
export type MemoryCategory = 'GlobalStatic' | 'Dynamic' | 'Stack';
export type VariableDeclaration = {
    name: string;
    type: Type;
    memoryCategory: MemoryCategory;
};
export type IdentifierDict = { [name: string]: Type }; // TODO: Don't export this (or rethink it)
export type Function = {
    name: string;
    statements: UninferredStatement[];
    variables: VariableDeclaration[];
    argument: VariableDeclaration;
    temporaryCount: number;
    knownIdentifiers: IdentifierDict;
};
export type BackendInputs = {
    functions: Function[];
    program: Function;
    globalDeclarations: VariableDeclaration[];
    stringLiterals;
};
export type ExecutionResult =
    | {
          exitCode: number;
          stdout: string;
      }
    | {
          error: string;
      };
export type ParseError = string;
export type Backend = {
    name: string;
    toExectuable: (BackendInputs) => string;
    execute: (string) => Promise<ExecutionResult>; // Exit code or error
    debug?: (string) => Promise<void>;
};
