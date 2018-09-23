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
          errors: {
              expected: string;
              found: string;
              sourceLocation: SourceLocation;
          }[];
      }
    | {
          kind: 'unexpectedProgram';
      }
    | {
          kind: 'internalError';
      };

export type TypeError =
    | {
          kind: 'unknownIdentifier';
          name: string;
          sourceLocation: SourceLocation;
      }
    | {
          kind: 'wrongTypeForOperator';
          found: Type;
          expected: string;
          operator: string;
          side: 'left' | 'right';
          sourceLocation: SourceLocation;
      }
    | { kind: 'assignUndeclaredIdentifer'; destinationName: string; sourceLocation: SourceLocation }
    | { kind: 'wrongTypeReturn'; expressionType: Type; sourceLocation: SourceLocation }
    | {
          kind: 'wrongArgumentType';
          targetFunction: string;
          passedType: Type;
          expectedType: Type;
          sourceLocation: SourceLocation;
      }
    | { kind: 'calledNonFunction'; identifierName: string; actualType: Type; sourceLocation: SourceLocation }
    | {
          kind: 'wrongNumberOfArguments';
          targetFunction: string;
          passedArgumentCount: number;
          expectedArgumentCount: number;
          sourceLocation: SourceLocation;
      }
    | { kind: 'unknownTypeForIdentifier'; identifierName: string; sourceLocation: SourceLocation }
    | { kind: 'ternaryBranchMismatch'; trueBranchType: Type; falseBranchType: Type; sourceLocation: SourceLocation }
    | {
          kind: 'typeMismatchForOperator';
          leftType: Type;
          rightType: Type;
          operator: string;
          sourceLocation: SourceLocation;
      }
    | { kind: 'assignWrongType'; lhsName: string; lhsType: Type; rhsType: Type; sourceLocation: SourceLocation }
    | { kind: 'invalidMemberAccess'; found: Type; sourceLocation: SourceLocation }
    | { kind: 'objectDoesNotHaveMember'; lhsType: Type; member: string; sourceLocation: SourceLocation }
    | { kind: 'couldNotFindType'; name: string; sourceLocation: SourceLocation };

export type Backend = {
    name: string;
    toExectuable: (BackendInputs) => string;
    execute: (string) => Promise<ExecutionResult>; // Exit code or error
    debug?: (string) => Promise<void>;
    runtimeFunctions?: ThreeAddressFunction[];
};
