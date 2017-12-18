export type Number = {
    kind: 'number';
    value: number;
};

export type Identifier = {
    kind: 'identifier';
    value: string;
};

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

export type BooleanLiteral = {
    kind: 'booleanLiteral';
    value: boolean;
}

export type StringLiteral = {
    kind: 'stringLiteral';
    value: string;
};

export type Concatenation = {
    kind: 'concatenation';
    lhs: LoweredAst;
    rhs: LoweredAst;
};

export type LoweredAst =
    ReturnStatement |
    Number |
    Ternary |
    Identifier |
    Equality |
    TypedAssignment |
    FunctionCall |
    FunctionLiteral |
    Statement |
    Subtraction |
    Addition |
    Product |
    BooleanLiteral |
    StringEquality |
    StringLiteral |
    Concatenation;
