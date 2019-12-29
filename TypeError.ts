import debug from './util/debug.js';
import SourceLocation from './parser-lib/sourceLocation.js';
import { Type } from './types.js';

export type TypeError = { sourceLocation: SourceLocation } & (
    | { kind: 'unknownIdentifier'; name: string }
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
    | {
          kind: 'typeMismatchForOperator';
          leftType: Type;
          rightType: Type;
          operator: string;
      }
    | { kind: 'assignWrongType'; lhsName: string; lhsType: Type; rhsType: Type }
    | { kind: 'invalidMemberAccess'; found: Type }
    | { kind: 'objectDoesNotHaveMember'; lhsType: Type; member: string }
    | { kind: 'couldNotFindType'; name: string }
    | {
          // TODO infer nonhomogenousList as sum type so this isn't an erro,
          kind: 'nonhomogenousList';
      }
    | { kind: 'nonIntegerIndex'; index: Type }
    | { kind: 'indexAccessNonList'; accessed: Type }
);

export const toString = (e: TypeError): string => {
    switch (e.kind) {
        case 'assignUndeclaredIdentifer':
            return `Unknown identifier ${e.destinationName}`;
        case 'unknownIdentifier':
            return `Unknown identifier ${e.name}`;
        case 'wrongNumberOfArguments':
            return `Wrong number of arguments for ${e.targetFunction}. Expected ${e.expectedArgumentCount}, found ${e.passedArgumentCount}`;
        default:
            throw debug(`need string for error: ${e.kind}`);
    }
};
