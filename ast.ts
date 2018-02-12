import { Type, VariableDeclaration } from './api.js';

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
    expression: Ast;
};

export type Ternary = {
    kind: 'ternary';
    condition: Ast;
    ifTrue: Ast;
    ifFalse: Ast;
};

export type Equality = {
    kind: 'equality';
    lhs: Ast;
    rhs: Ast;
    type: Type;
};

export type TypedAssignment = {
    kind: 'typedAssignment';
    type: Type;
    destination: string;
    expression: Ast;
};

export type FunctionCall = {
    kind: 'callExpression';
    name: string;
    arguments: Ast[];
};

export type FunctionLiteral = {
    kind: 'functionLiteral';
    deanonymizedName: string;
};

export type Statement = TypedAssignment | ReturnStatement;

export type Addition = {
    kind: 'addition';
    lhs: Ast;
    rhs: Ast;
};

export type Subtraction = {
    kind: 'subtraction';
    lhs: Ast;
    rhs: Ast;
};

export type Product = {
    kind: 'product';
    lhs: Ast;
    rhs: Ast;
};

export type Concatenation = {
    kind: 'concatenation';
    lhs: Ast;
    rhs: Ast;
};

export type Ast =
    | Leaf
    | Ternary
    | Equality
    | FunctionCall
    | FunctionLiteral
    | Statement
    | Subtraction
    | Addition
    | Product
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
    arguments: UninferredAst[];
};

export type UninferredFunctionLiteral = {
    kind: 'functionLiteral';
    deanonymizedName: string;
    body: any;
    parameters: VariableDeclaration[];
};

export type UninferredStatement = UninferredTypedAssignment | UninferredAssignment | UninferredReturnStatement;

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

export type UninferredProgram = {
    kind: 'program';
    statements: UninferredStatement[];
};

export type UninferredAst =
    | Leaf
    | UninferredTernary
    | UninferredEquality
    | UninferredFunctionCall
    | UninferredFunctionLiteral
    | UninferredStatement
    | UninferredSubtraction
    | UninferredAddition
    | UninferredProduct
    | UninferredStringEquality
    | UninferredConcatenation
    | UninferredProgram;
