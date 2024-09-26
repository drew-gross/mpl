import SourceLocation from './parser-lib/sourceLocation';
import { Leaf } from './ast';
import { Variable } from './api';
import { TypeExpression } from './frontend';

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
    type: TypeExpression | undefined;
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

export type Parameter = {
    name: string;
    type: TypeExpression;
};

export type FunctionLiteral = {
    kind: 'functionLiteral';
    sourceLocation: SourceLocation;
    body: Statement[];
    parameters: Parameter[];
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

export type Statement = Declaration | Reassignment | ForLoop | ReturnStatement;

export type Expression =
    | Leaf
    | ObjectLiteral
    | Ternary
    | Equality
    | FunctionCall
    | FunctionLiteral
    | Subtraction
    | Addition
    | Product
    | Concatenation
    | MemberAccess
    | MemberStyleCall
    | ListLiteral
    | IndexAccess;

export type Ast = Statement | Program | Expression;
