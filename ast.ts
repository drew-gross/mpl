import { Type } from './api.js';

// Leaf nodes

type Leaf = Number | Identifier | BooleanLiteral | StringLiteral;

export type Number = {
    kind: 'number';
    value: number;
};

export type Identifier = {
    kind: 'identifier';
    value: string;
};

export type BooleanLiteral = {
    kind: 'booleanLiteral';
    value: boolean;
};

export type StringLiteral = {
    kind: 'stringLiteral';
    value: string;
};

// Typed versions of things (...kinda)
export type ReturnStatement = {
    kind: 'returnStatement';
    expression: LoweredAst;
};

export type Ternary = {
    kind: 'ternary';
    condition: LoweredAst;
    ifTrue: LoweredAst;
    ifFalse: LoweredAst;
};

// TODO: merge Equality with StringEquality and add type to ast node
export type Equality = {
    kind: 'equality';
    lhs: LoweredAst;
    rhs: LoweredAst;
};

export type StringEquality = {
    kind: 'stringEquality';
    lhs: LoweredAst;
    rhs: LoweredAst;
};

export type TypedAssignment = {
    kind: 'typedAssignment';
    type: Type;
    destination: string;
    expression: LoweredAst;
};

export type FunctionCall = {
    kind: 'callExpression';
    name: string;
    argument: LoweredAst;
};

export type FunctionLiteral = {
    kind: 'functionLiteral';
    deanonymizedName: string;
};

export type Statement = {
    kind: 'statement';
    children: any;
};

export type Addition = {
    kind: 'addition';
    lhs: LoweredAst;
    rhs: LoweredAst;
};

export type Subtraction = {
    kind: 'subtraction';
    lhs: LoweredAst;
    rhs: LoweredAst;
};

export type Product = {
    kind: 'product';
    lhs: LoweredAst;
    rhs: LoweredAst;
};

export type Concatenation = {
    kind: 'concatenation';
    lhs: LoweredAst;
    rhs: LoweredAst;
};

export type LoweredAst =
    | Leaf
    | ReturnStatement
    | Ternary
    | Equality
    | TypedAssignment
    | FunctionCall
    | FunctionLiteral
    | Statement
    | Subtraction
    | Addition
    | Product
    | StringEquality
    | Concatenation;

// Untyped versions (...kinda)

export type UninferredReturnStatement = {
    kind: 'returnStatement';
    expression: UninferredAst;
};

export type UninferredTernary = {
    kind: 'ternary';
    condition: UninferredAst;
    ifTrue: UninferredAst;
    ifFalse: UninferredAst;
};

// TODO: merge Equality with StringEquality and add type to ast node
export type UninferredEquality = {
    kind: 'equality';
    lhs: UninferredAst;
    rhs: UninferredAst;
};

export type UninferredStringEquality = {
    kind: 'stringEquality';
    lhs: UninferredAst;
    rhs: UninferredAst;
};

export type UninferredTypedAssignment = {
    kind: 'typedAssignment';
    destination: string;
    type: Type;
    expression: UninferredAst;
};

export type UninferredFunctionCall = {
    kind: 'callExpression';
    name: string;
    argument: UninferredAst;
};

export type UninferredFunctionLiteral = {
    kind: 'functionLiteral';
    deanonymizedName: string;
};

export type UninferredStatement = {
    kind: 'statement';
    children: any;
};

export type UninferredAddition = {
    kind: 'addition';
    lhs: UninferredAst;
    rhs: UninferredAst;
};

export type UninferredSubtraction = {
    kind: 'subtraction';
    lhs: UninferredAst;
    rhs: UninferredAst;
};

export type UninferredProduct = {
    kind: 'product';
    lhs: UninferredAst;
    rhs: UninferredAst;
};

export type UninferredConcatenation = {
    kind: 'concatenation';
    lhs: UninferredAst;
    rhs: UninferredAst;
};

export type UninferredAssignment = {
    kind: 'assignment';
    destination: string;
    expression: UninferredAst;
};

export type UninferredAst =
    | Leaf
    | UninferredReturnStatement
    | UninferredTernary
    | UninferredEquality
    | UninferredTypedAssignment
    | UninferredFunctionCall
    | UninferredFunctionLiteral
    | UninferredStatement
    | UninferredSubtraction
    | UninferredAddition
    | UninferredProduct
    | UninferredStringEquality
    | UninferredConcatenation
    | UninferredAssignment;
