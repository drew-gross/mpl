import SourceLocation from './parser-lib/sourceLocation';
import { Type, TypeReference } from './types';
import { Variable } from './api';
import { Leaf } from './ast';

export type ReturnStatement = {
    kind: 'returnStatement';
    sourceLocation: SourceLocation;
    expression: Expression;
};

export type Ternary = {
    kind: 'ternary';
    sourceLocation: SourceLocation;
    condition: Expression;
    ifTrue: Expression;
    ifFalse: Expression;
};

export type FunctionReference = {
    kind: 'functionReference';
    sourceLocation: SourceLocation;
    value: string;
};

export type Equality = {
    kind: 'equality';
    sourceLocation: SourceLocation;
    lhs: Expression;
    rhs: Expression;
};

export type Declaration = {
    kind: 'declaration';
    sourceLocation: SourceLocation;
    destination: string;
    type: Type | TypeReference;
    expression: Expression;
    exported: boolean;
};

export type Reassignment = {
    kind: 'reassignment';
    sourceLocation: SourceLocation;
    destination: string;
    expression: Expression;
};

export type FunctionCall = {
    kind: 'callExpression';
    sourceLocation: SourceLocation;
    name: string;
    arguments: Expression[];
};

export type MemberStyleCall = {
    kind: 'memberStyleCall';
    sourceLocation: SourceLocation;
    lhs: Expression;
    memberName: string;
    params: Expression[];
};

export type MemberAccess = {
    kind: 'memberAccess';
    sourceLocation: SourceLocation;
    lhs: Expression;
    rhs: string;
};

export type Addition = {
    kind: 'addition';
    sourceLocation: SourceLocation;
    lhs: Expression;
    rhs: Expression;
};

export type Subtraction = {
    kind: 'subtraction';
    sourceLocation: SourceLocation;
    lhs: Expression;
    rhs: Expression;
};

export type Product = {
    kind: 'product';
    sourceLocation: SourceLocation;
    lhs: Expression;
    rhs: Expression;
};

export type Concatenation = {
    kind: 'concatenation';
    sourceLocation: SourceLocation;
    lhs: Expression;
    rhs: Expression;
};

export type TypeDeclaration = {
    kind: 'typeDeclaration';
    sourceLocation: SourceLocation;
    name: string;
    type: Type;
};

export type ForLoop = {
    kind: 'forLoop';
    sourceLocation: SourceLocation;
    var: Variable;
    list: Expression;
    body: Statement[];
};

export type ObjectMember = {
    name: string;
    expression: Expression;
};

export type ObjectLiteral = {
    kind: 'objectLiteral';
    sourceLocation: SourceLocation;
    typeName: string;
    members: ObjectMember[];
};

export type ListLiteral = {
    kind: 'listLiteral';
    sourceLocation: SourceLocation;
    items: Expression[];
};

export type IndexAccess = {
    kind: 'indexAccess';
    sourceLocation: SourceLocation;
    index: Expression;
    accessed: Expression;
};

export type Program = {
    kind: 'program';
    sourceLocation: SourceLocation;
    statements: Statement[];
};

export type Statement = Declaration | Reassignment | TypeDeclaration | ForLoop | ReturnStatement;

export type Expression =
    | Leaf
    | ObjectLiteral
    | Ternary
    | Equality
    | FunctionCall
    | FunctionReference
    | Subtraction
    | Addition
    | Product
    | Concatenation
    | MemberAccess
    | MemberStyleCall
    | ListLiteral
    | IndexAccess;

export type Ast = Statement | Program | Expression;

export type ExtractedFunction = {
    sourceLocation: SourceLocation;
    statements: Statement[];
    parameters: Variable[];
};

export type ExtractedFunctionWithVariables = {
    sourceLocation: SourceLocation;
    statements: Statement[];
    parameters: Variable[];
    variables: Variable[];
};
