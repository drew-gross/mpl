import debug from './util/debug';
import SourceLocation from './parser-lib/sourceLocation';
import { Type, toString as typeToString } from './types';

export type TypeError = { sourceLocation: SourceLocation } & (
    | { kind: 'unknownIdentifier'; name: string }
    | { kind: 'unknownType'; name: string }
    | {
          kind: 'wrongTypeForOperator';
          found: Type;
          expected: string;
          operator: string;
          side: 'left' | 'right';
      }
    | { kind: 'assignUndeclaredIdentifer'; destinationName: string }
    | { kind: 'missingReturn' }
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
    | { kind: 'uninferrableEmptyList' }
    | { kind: 'nonIntegerIndex'; index: Type }
    | { kind: 'indexAccessNonList'; accessed: Type }
    | { kind: 'topLevelStatementsInModule' }
    | { kind: 'nonListInFor'; found: Type }
);

export const toString = (e: TypeError): string => {
    switch (e.kind) {
        case 'assignUndeclaredIdentifer':
            return `Unknown identifier ${e.destinationName}`;
        case 'unknownIdentifier':
            return `Unknown identifier ${e.name}`;
        case 'unknownType':
            return `Unknown type ${e.name}`;
        case 'wrongNumberOfArguments':
            return `Wrong number of arguments for ${e.targetFunction}. Expected ${e.expectedArgumentCount}, found ${e.passedArgumentCount}`;
        case 'assignWrongType':
            return `Wrong type for ${e.lhsName}. Expected ${typeToString(
                e.lhsType
            )}, found ${typeToString(e.rhsType)}.`;
        case 'wrongArgumentType':
            return `Wrong argument type for ${e.targetFunction}. Expected ${typeToString(
                e.expectedType
            )}, found ${typeToString(e.passedType)}.`;
        case 'topLevelStatementsInModule':
            return `Modules may not have top level statements.`;
        case 'missingReturn':
            return 'Missing final return statement';
        case 'objectDoesNotHaveMember':
            return `Object of type ${typeToString(e.lhsType)} does not have member ${e.member}`;
        case 'unknownTypeForIdentifier':
            return `Could not find a type for ${e.identifierName}`;
        case 'nonListInFor':
            return `Iterating type ${typeToString(e.found)} which is not iterable`;
        default:
            throw debug(`need string for error: ${e.kind}`);
    }
};
