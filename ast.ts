import { VariableDeclaration, SourceLocation } from './api.js';
import { Type } from './types.js';

type Leaf = Number | Identifier | BooleanLiteral | StringLiteral;

export type Number = {
    kind: 'number';
    sourceLocation: SourceLocation;
    value: number;
};

export type Identifier = {
    kind: 'identifier';
    sourceLocation: SourceLocation;
    value: string;
};

export type BooleanLiteral = {
    kind: 'booleanLiteral';
    sourceLocation: SourceLocation;
    value: boolean;
};

export type StringLiteral = {
    kind: 'stringLiteral';
    sourceLocation: SourceLocation;
    value: string;
};

// Typed versions of things (...kinda)
export type ReturnStatement = {
    kind: 'returnStatement';
    sourceLocation: SourceLocation;
    expression: Ast;
};

export type Ternary = {
    kind: 'ternary';
    sourceLocation: SourceLocation;
    condition: Ast;
    ifTrue: Ast;
    ifFalse: Ast;
};

export type Equality = {
    kind: 'equality';
    sourceLocation: SourceLocation;
    lhs: Ast;
    rhs: Ast;
    type: Type;
};

export type TypedDeclarationAssignment = {
    kind: 'typedDeclarationAssignment';
    sourceLocation: SourceLocation;
    type: Type;
    destination: string;
    expression: Ast;
};

export type Reassignment = {
    kind: 'reassignment';
    sourceLocation: SourceLocation;
    destination: string;
    expression: Ast;
};

export type FunctionCall = {
    kind: 'callExpression';
    sourceLocation: SourceLocation;
    name: string;
    arguments: Ast[];
};

export type FunctionLiteral = {
    kind: 'functionLiteral';
    sourceLocation: SourceLocation;
    deanonymizedName: string;
};

export type Statement = TypedDeclarationAssignment | Reassignment | ReturnStatement;

export type Addition = {
    kind: 'addition';
    sourceLocation: SourceLocation;
    lhs: Ast;
    rhs: Ast;
};

export type Subtraction = {
    kind: 'subtraction';
    sourceLocation: SourceLocation;
    lhs: Ast;
    rhs: Ast;
};

export type Product = {
    kind: 'product';
    sourceLocation: SourceLocation;
    lhs: Ast;
    rhs: Ast;
};

export type Concatenation = {
    kind: 'concatenation';
    sourceLocation: SourceLocation;
    lhs: Ast;
    rhs: Ast;
};

export type TypeDeclaration = {
    kind: 'typeDeclaration';
    sourceLocation: SourceLocation;
};

export type ObjectMember = {
    name: string;
    expression: Ast;
};

export type ObjectLiteral = {
    kind: 'objectLiteral';
    sourceLocation: SourceLocation;
    type: Type;
    members: ObjectMember[];
};

export type MemberAccess = {
    kind: 'memberAccess';
    sourceLocation: SourceLocation;
    lhs: Ast;
    rhs: string;
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
    | Concatenation
    | TypeDeclaration
    | ObjectLiteral
    | MemberAccess;

// Untyped versions (...kinda)

export type UninferredReturnStatement = {
    kind: 'returnStatement';
    sourceLocation: SourceLocation;
    expression: UninferredAst;
};

export type UninferredTernary = {
    kind: 'ternary';
    sourceLocation: SourceLocation;
    condition: UninferredAst;
    ifTrue: UninferredAst;
    ifFalse: UninferredAst;
};

export type UninferredEquality = {
    kind: 'equality';
    sourceLocation: SourceLocation;
    lhs: UninferredAst;
    rhs: UninferredAst;
};

export type UninferredTypedDeclarationAssignment = {
    kind: 'typedDeclarationAssignment';
    sourceLocation: SourceLocation;
    destination: string;
    type: Type;
    expression: UninferredAst;
};

export type UninferredReassignment = {
    kind: 'reassignment';
    sourceLocation: SourceLocation;
    destination: string;
    expression: UninferredAst;
};

export type UninferredFunctionCall = {
    kind: 'callExpression';
    sourceLocation: SourceLocation;
    name: string;
    arguments: UninferredAst[];
};

export type UninferredMemberAccess = {
    kind: 'memberAccess';
    sourceLocation: SourceLocation;
    lhs: UninferredAst;
    rhs: string;
};

export type UninferredFunctionLiteral = {
    kind: 'functionLiteral';
    sourceLocation: SourceLocation;
    deanonymizedName: string;
    body: UninferredStatement[];
    parameters: VariableDeclaration[];
};

export type UninferredAddition = {
    kind: 'addition';
    sourceLocation: SourceLocation;
    lhs: UninferredAst;
    rhs: UninferredAst;
};

export type UninferredSubtraction = {
    kind: 'subtraction';
    sourceLocation: SourceLocation;
    lhs: UninferredAst;
    rhs: UninferredAst;
};

export type UninferredProduct = {
    kind: 'product';
    sourceLocation: SourceLocation;
    lhs: UninferredAst;
    rhs: UninferredAst;
};

export type UninferredConcatenation = {
    kind: 'concatenation';
    sourceLocation: SourceLocation;
    lhs: UninferredAst;
    rhs: UninferredAst;
};

export type UninferredDeclarationAssignment = {
    kind: 'declarationAssignment';
    sourceLocation: SourceLocation;
    destination: string;
    expression: UninferredAst;
};

export type UninferredTypeDeclaration = {
    kind: 'typeDeclaration';
    sourceLocation: SourceLocation;
    name: string;
    type: Type;
};

export type UninferredObjectMember = {
    name: string;
    expression: UninferredAst;
};

export type UninferredObjectLiteral = {
    kind: 'objectLiteral';
    sourceLocation: SourceLocation;
    typeName: string;
    members: UninferredObjectMember[];
};

export type UninferredProgram = {
    kind: 'program';
    sourceLocation: SourceLocation;
    statements: UninferredStatement[];
};

export type UninferredStatement =
    | UninferredTypedDeclarationAssignment
    | UninferredDeclarationAssignment
    | UninferredReassignment
    | UninferredTypeDeclaration
    | UninferredReturnStatement;

export type UninferredExpression =
    | Leaf
    | UninferredObjectLiteral
    | UninferredTernary
    | UninferredEquality
    | UninferredFunctionCall
    | UninferredFunctionLiteral
    | UninferredSubtraction
    | UninferredAddition
    | UninferredProduct
    | UninferredConcatenation
    | UninferredMemberAccess;

export type UninferredAst = UninferredStatement | UninferredProgram | UninferredExpression;
