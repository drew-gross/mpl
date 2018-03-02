import { UninferredStatement, Statement } from './ast.js';

export type Type = {
    name: 'String' | 'Integer' | 'Boolean' | 'Function';
    arguments: Type[];
};
export type TypeError = string;
export type VariableLocation = 'Global' | 'Parameter' | 'Stack';
export type VariableDeclaration = {
    name: string;
    type: Type;
    location: VariableLocation;
};
export type UninferredFunction = {
    // TODO: Don't export this (or rethink it)
    name: string;
    statements: UninferredStatement[];
    variables: VariableDeclaration[];
    parameters: VariableDeclaration[];
    temporaryCount: number;
};
export type Function = {
    name: string;
    statements: Statement[];
    variables: VariableDeclaration[];
    parameters: VariableDeclaration[];
    temporaryCount: number;
};
export type StringLiteralData = { id: number; value: string };
export type BackendInputs = {
    functions: Function[];
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
export type ParseError =
    | {
          kind: 'unexpectedToken';
          expected: string[];
          found: string[];
          sourceLine: number;
          sourceColumn: number;
      }
    | {
          kind: 'unexpectedProgram';
      };
export type Backend = {
    name: string;
    toExectuable: (BackendInputs) => string;
    execute: (string) => Promise<ExecutionResult>; // Exit code or error
    debug?: (string) => Promise<void>;
};
