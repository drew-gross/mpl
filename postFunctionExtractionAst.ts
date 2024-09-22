import SourceLocation from './parser-lib/sourceLocation';
import { Type, TypeReference } from './types';
import { Variable } from './api';
import { Leaf } from './ast';

export type PostFunctionExtractionReturnStatement = {
    kind: 'returnStatement';
    sourceLocation: SourceLocation;
    expression: PostFunctionExtractionExpression;
};

export type PostFunctionExtractionTernary = {
    kind: 'ternary';
    sourceLocation: SourceLocation;
    condition: PostFunctionExtractionExpression;
    ifTrue: PostFunctionExtractionExpression;
    ifFalse: PostFunctionExtractionExpression;
};

export type FunctionReference = {
    kind: 'functionReference';
    sourceLocation: SourceLocation;
    value: string;
};

export type PostFunctionExtractionEquality = {
    kind: 'equality';
    sourceLocation: SourceLocation;
    lhs: PostFunctionExtractionExpression;
    rhs: PostFunctionExtractionExpression;
};

export type PostFunctionExtractionTypedDeclarationAssignment = {
    kind: 'typedDeclarationAssignment';
    sourceLocation: SourceLocation;
    destination: string;
    type: Type | TypeReference;
    expression: PostFunctionExtractionExpression;
    exported: boolean;
};

export type PostFunctionExtractionReassignment = {
    kind: 'reassignment';
    sourceLocation: SourceLocation;
    destination: string;
    expression: PostFunctionExtractionExpression;
};

export type PostFunctionExtractionFunctionCall = {
    kind: 'callExpression';
    sourceLocation: SourceLocation;
    name: string;
    arguments: PostFunctionExtractionExpression[];
};

export type PostFunctionExtractionMemberStyleCall = {
    kind: 'memberStyleCall';
    sourceLocation: SourceLocation;
    lhs: PostFunctionExtractionExpression;
    memberName: string;
    params: PostFunctionExtractionExpression[];
};

export type PostFunctionExtractionMemberAccess = {
    kind: 'memberAccess';
    sourceLocation: SourceLocation;
    lhs: PostFunctionExtractionExpression;
    rhs: string;
};

export type PostFunctionExtractionAddition = {
    kind: 'addition';
    sourceLocation: SourceLocation;
    lhs: PostFunctionExtractionExpression;
    rhs: PostFunctionExtractionExpression;
};

export type PostFunctionExtractionSubtraction = {
    kind: 'subtraction';
    sourceLocation: SourceLocation;
    lhs: PostFunctionExtractionExpression;
    rhs: PostFunctionExtractionExpression;
};

export type PostFunctionExtractionProduct = {
    kind: 'product';
    sourceLocation: SourceLocation;
    lhs: PostFunctionExtractionExpression;
    rhs: PostFunctionExtractionExpression;
};

export type PostFunctionExtractionConcatenation = {
    kind: 'concatenation';
    sourceLocation: SourceLocation;
    lhs: PostFunctionExtractionExpression;
    rhs: PostFunctionExtractionExpression;
};

// TODO: merge this with TypedDeclarationAssignment, make "requested" type optional
export type PostFunctionExtractionDeclarationAssignment = {
    kind: 'declarationAssignment';
    sourceLocation: SourceLocation;
    destination: string;
    expression: PostFunctionExtractionExpression;
    exported: boolean;
};

export type PostFunctionExtractionTypeDeclaration = {
    kind: 'typeDeclaration';
    sourceLocation: SourceLocation;
    name: string;
    type: Type;
};

export type PostFunctionExtractionForLoop = {
    kind: 'forLoop';
    sourceLocation: SourceLocation;
    var: Variable;
    list: PostFunctionExtractionExpression;
    body: PostFunctionExtractionStatement[];
};

export type PostFunctionExtractionObjectMember = {
    name: string;
    expression: PostFunctionExtractionExpression;
};

export type PostFunctionExtractionObjectLiteral = {
    kind: 'objectLiteral';
    sourceLocation: SourceLocation;
    typeName: string;
    members: PostFunctionExtractionObjectMember[];
};

export type PostFunctionExtractionListLiteral = {
    kind: 'listLiteral';
    sourceLocation: SourceLocation;
    items: PostFunctionExtractionExpression[];
};

export type PostFunctionExtractionIndexAccess = {
    kind: 'indexAccess';
    sourceLocation: SourceLocation;
    index: PostFunctionExtractionExpression;
    accessed: PostFunctionExtractionExpression;
};

export type PostFunctionExtractionProgram = {
    kind: 'program';
    sourceLocation: SourceLocation;
    statements: PostFunctionExtractionStatement[];
};

export type PostFunctionExtractionStatement =
    | PostFunctionExtractionTypedDeclarationAssignment
    | PostFunctionExtractionDeclarationAssignment
    | PostFunctionExtractionReassignment
    | PostFunctionExtractionTypeDeclaration
    | PostFunctionExtractionForLoop
    | PostFunctionExtractionReturnStatement;

export type PostFunctionExtractionExpression =
    | Leaf
    | PostFunctionExtractionObjectLiteral
    | PostFunctionExtractionTernary
    | PostFunctionExtractionEquality
    | PostFunctionExtractionFunctionCall
    | FunctionReference
    | PostFunctionExtractionSubtraction
    | PostFunctionExtractionAddition
    | PostFunctionExtractionProduct
    | PostFunctionExtractionConcatenation
    | PostFunctionExtractionMemberAccess
    | PostFunctionExtractionMemberStyleCall
    | PostFunctionExtractionListLiteral
    | PostFunctionExtractionIndexAccess;

export type PostFunctionExtractionAst =
    | PostFunctionExtractionStatement
    | PostFunctionExtractionProgram
    | PostFunctionExtractionExpression;

export type ExtractedFunction = {
    sourceLocation: SourceLocation;
    statements: PostFunctionExtractionStatement[];
    parameters: Variable[];
};

export type ExtractedFunctionWithVariables = {
    sourceLocation: SourceLocation;
    statements: PostFunctionExtractionStatement[];
    parameters: Variable[];
    variables: Variable[];
};
