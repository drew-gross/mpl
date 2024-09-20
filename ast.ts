import { Variable } from './api';
import SourceLocation from './parser-lib/sourceLocation';
import { Type, TypeReference } from './types';
import debug from './util/debug';
import join from './util/join';

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

export type ReturnStatement = {
    kind: 'returnStatement';
    sourceLocation: SourceLocation;
    expression: Ast;
};

export type ForLoop = {
    kind: 'forLoop';
    sourceLocation: SourceLocation;
    var: Variable;
    list: Ast;
    body: Statement[];
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

// In an Ast, each function is stored in a map from name to contents. The reference refers to the function name in that map.
export type FunctionReference = {
    kind: 'functionReference';
    sourceLocation: SourceLocation;
    name: string;
};

export type Statement = TypedDeclarationAssignment | Reassignment | ReturnStatement | ForLoop;

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

export type ListLiteral = {
    kind: 'listLiteral';
    sourceLocation: SourceLocation;
    type: Type;
    items: Ast[];
};

export type MemberAccess = {
    kind: 'memberAccess';
    sourceLocation: SourceLocation;
    lhs: Ast;
    lhsType: Type;
    rhs: string;
};

export type IndexAccess = {
    kind: 'indexAccess';
    sourceLocation: SourceLocation;
    accessed: Ast;
    index: Ast;
    // TODO: add list item type here
};

export type Ast =
    | Leaf
    | Ternary
    | Equality
    | FunctionCall
    | FunctionReference
    | Statement
    | Subtraction
    | Addition
    | Product
    | Concatenation
    | TypeDeclaration
    | ObjectLiteral
    | ListLiteral
    | IndexAccess
    | MemberAccess;

// Untyped versions (...kinda)

export type PreFunctionExtractionReturnStatement = {
    kind: 'returnStatement';
    sourceLocation: SourceLocation;
    expression: PreFunctionExtractionExpression;
};

export type PreFunctionExtractionTernary = {
    kind: 'ternary';
    sourceLocation: SourceLocation;
    condition: PreFunctionExtractionExpression;
    ifTrue: PreFunctionExtractionExpression;
    ifFalse: PreFunctionExtractionExpression;
};

export type PreFunctionExtractionEquality = {
    kind: 'equality';
    sourceLocation: SourceLocation;
    lhs: PreFunctionExtractionExpression;
    rhs: PreFunctionExtractionExpression;
};

export type PreFunctionExtractionTypedDeclarationAssignment = {
    kind: 'typedDeclarationAssignment';
    sourceLocation: SourceLocation;
    destination: string;
    type: Type | TypeReference;
    expression: PreFunctionExtractionExpression;
    exported: boolean;
};

export type PreFunctionExtractionReassignment = {
    kind: 'reassignment';
    sourceLocation: SourceLocation;
    destination: string;
    expression: PreFunctionExtractionExpression;
};

export type PreFunctionExtractionFunctionCall = {
    kind: 'callExpression';
    sourceLocation: SourceLocation;
    name: string;
    arguments: PreFunctionExtractionExpression[];
};

export type PreFunctionExtractionMemberStyleCall = {
    kind: 'memberStyleCall';
    sourceLocation: SourceLocation;
    lhs: PreFunctionExtractionExpression;
    memberName: string;
    params: PreFunctionExtractionExpression[];
};

export type PreFunctionExtractionMemberAccess = {
    kind: 'memberAccess';
    sourceLocation: SourceLocation;
    lhs: PreFunctionExtractionExpression;
    rhs: string;
};

export type PreFunctionExtractionFunctionLiteral = {
    kind: 'functionLiteral';
    sourceLocation: SourceLocation;
    body: PreFunctionExtractionStatement[];
    parameters: Variable[];
};

export type PreFunctionExtractionAddition = {
    kind: 'addition';
    sourceLocation: SourceLocation;
    lhs: PreFunctionExtractionExpression;
    rhs: PreFunctionExtractionExpression;
};

export type PreFunctionExtractionSubtraction = {
    kind: 'subtraction';
    sourceLocation: SourceLocation;
    lhs: PreFunctionExtractionExpression;
    rhs: PreFunctionExtractionExpression;
};

export type PreFunctionExtractionProduct = {
    kind: 'product';
    sourceLocation: SourceLocation;
    lhs: PreFunctionExtractionExpression;
    rhs: PreFunctionExtractionExpression;
};

export type PreFunctionExtractionConcatenation = {
    kind: 'concatenation';
    sourceLocation: SourceLocation;
    lhs: PreFunctionExtractionExpression;
    rhs: PreFunctionExtractionExpression;
};

// TODO: merge this with TypedDeclarationAssignment, make "requested" type optional
export type PreFunctionExtractionDeclarationAssignment = {
    kind: 'declarationAssignment';
    sourceLocation: SourceLocation;
    destination: string;
    expression: PreFunctionExtractionExpression;
    exported: boolean;
};

export type PreFunctionExtractionTypeDeclaration = {
    kind: 'typeDeclaration';
    sourceLocation: SourceLocation;
    name: string;
    type: Type;
};

export type PreFunctionExtractionForLoop = {
    kind: 'forLoop';
    sourceLocation: SourceLocation;
    var: Variable;
    list: PreFunctionExtractionExpression;
    body: PreFunctionExtractionStatement[];
};

export type PreFunctionExtractionObjectMember = {
    name: string;
    expression: PreFunctionExtractionExpression;
};

export type PreFunctionExtractionObjectLiteral = {
    kind: 'objectLiteral';
    sourceLocation: SourceLocation;
    typeName: string;
    members: PreFunctionExtractionObjectMember[];
};

export type PreFunctionExtractionListLiteral = {
    kind: 'listLiteral';
    sourceLocation: SourceLocation;
    items: PreFunctionExtractionExpression[];
};

export type PreFunctionExtractionIndexAccess = {
    kind: 'indexAccess';
    sourceLocation: SourceLocation;
    index: PreFunctionExtractionExpression;
    accessed: PreFunctionExtractionExpression;
};

export type PreFunctionExtractionProgram = {
    kind: 'program';
    sourceLocation: SourceLocation;
    statements: PreFunctionExtractionStatement[];
};

export type PreFunctionExtractionStatement =
    | PreFunctionExtractionTypedDeclarationAssignment
    | PreFunctionExtractionDeclarationAssignment
    | PreFunctionExtractionReassignment
    | PreFunctionExtractionTypeDeclaration
    | PreFunctionExtractionForLoop
    | PreFunctionExtractionReturnStatement;

export type PreFunctionExtractionExpression =
    | Leaf
    | PreFunctionExtractionObjectLiteral
    | PreFunctionExtractionTernary
    | PreFunctionExtractionEquality
    | PreFunctionExtractionFunctionCall
    | PreFunctionExtractionFunctionLiteral
    | PreFunctionExtractionSubtraction
    | PreFunctionExtractionAddition
    | PreFunctionExtractionProduct
    | PreFunctionExtractionConcatenation
    | PreFunctionExtractionMemberAccess
    | PreFunctionExtractionMemberStyleCall
    | PreFunctionExtractionListLiteral
    | PreFunctionExtractionIndexAccess;

export type PreFunctionExtractionAst =
    | PreFunctionExtractionStatement
    | PreFunctionExtractionProgram
    | PreFunctionExtractionExpression;

export const astToString = (ast: Ast) => {
    if (!ast) debug('Null ast in astToString');
    switch (ast.kind) {
        case 'returnStatement':
            return `return ${astToString(ast.expression)}`;
        case 'forLoop':
            return `for (${ast.var} : ${astToString(ast.list)}) {
                ${join(ast.body.map(astToString), '\n')}
            };`;
        case 'ternary':
            return `${astToString(ast.condition)} ? ${astToString(ast.ifTrue)} : ${astToString(
                ast.ifFalse
            )}`;
        case 'equality':
            return `${astToString(ast.lhs)} == ${astToString(ast.rhs)}`;
        case 'identifier':
            return ast.value;
        case 'number':
            return ast.value.toString();
        case 'callExpression':
            const args = join(ast.arguments.map(astToString), ', ');
            return `${ast.name}(${args})`;
        case 'functionReference':
            return ast.name;
        case 'product':
            return `${astToString(ast.lhs)} * ${astToString(ast.rhs)}`;
        case 'addition':
            return `${astToString(ast.lhs)} + ${astToString(ast.rhs)}`;
        case 'subtraction':
            return `${astToString(ast.lhs)} - ${astToString(ast.rhs)}`;
        case 'stringLiteral':
            return `"${ast.value}"`;
        case 'booleanLiteral':
            return ast.value ? 'True' : 'False';
        case 'concatenation':
            return `${ast.lhs} ++ ${ast.rhs}`;
        case 'typedDeclarationAssignment':
            return `${ast.destination}: ${ast.type.type.kind} = ${astToString(ast.expression)};`;
        case 'typeDeclaration':
            return `(${ast.kind})`; // TODO: Figure out what parts of type declaration should go in AST vs uninferred AST.
        case 'reassignment':
            return `${ast.destination} = ${astToString(ast.expression)};`;
        case 'objectLiteral':
            const members = ast.members.map(
                ({ name, expression }) => `${name}: ${astToString(expression)}`
            );
            return `{ ${join(members, ', ')} }`;
        case 'memberAccess':
            return `(${astToString(ast.lhs)}).${ast.rhs}`;
        case 'listLiteral':
            return `[${join(ast.items.map(astToString), ', ')}]`;
        case 'indexAccess':
            return `(${astToString(ast.accessed)})[${astToString(ast.index)}]`;
        default:
            throw debug(`${(ast as any).kind} unhandled in astToString`);
    }
};
