import { UninferredStatement, Statement } from './ast.js';
import { ThreeAddressFunction } from './threeAddressCode/generator.js';
import { Type, TypeDeclaration } from './types.js';

export type SourceLocation = { line: number; column: number };

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
export type BackendInputs = {
    types: TypeDeclaration[];
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
export type TypeError = SourceLocation &
    (
        | {
              kind: 'unknownIdentifier';
              name: string;
          }
        | {
              kind: 'wrongTypeForOperator';
              found: Type;
              expected: string;
              operator: string;
              side: 'left' | 'right';
          }
        | { kind: 'assignUndeclaredIdentifer'; destinationName: string }
        | { kind: 'wrongTypeReturn'; expressionType: Type }
        | { kind: 'wrongArgumentType'; targetFunction: string; passedType: Type; expectedType: Type }
        | { kind: 'calledNonFunction'; identifierName: string; actualType: Type }
        | {
              kind: 'wrongNumberOfArguments';
              targetFunction: string;
              passedArgumentCount: number;
              expectedArgumentCount: number;
          }
        | { kind: 'unknownTypeForIdentifier'; identifierName: string }
        | { kind: 'ternaryBranchMismatch'; trueBranchType: Type; falseBranchType: Type }
        | { kind: 'typeMismatchForOperator'; leftType: Type; rightType: Type; operator: string }
        | { kind: 'assignWrongType'; lhsName: string; lhsType: Type; rhsType: Type }
        | { kind: 'invalidMemberAccess'; found: Type }
        | { kind: 'objectDoesNotHaveMember'; lhsType: Type; member: string }
        | { kind: 'couldNotFindType'; name: string });

export type Backend = {
    name: string;
    toExectuable: (BackendInputs) => string;
    execute: (string) => Promise<ExecutionResult>; // Exit code or error
    debug?: (string) => Promise<void>;
    runtimeFunctions?: ThreeAddressFunction[];
};
