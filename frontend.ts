import flatten from './util/list/flatten.js';
import unique from './util/list/unique.js';
import uniqueBy from './util/list/uniqueBy.js';
import sum from './util/list/sum.js';
import join from './util/join.js';
import last from './util/list/last.js';
import debug from './util/debug.js';
import { lex, Token } from './lex.js';
import { tokenSpecs, grammar, MplAst, MplParseResult, MplToken } from './grammar.js';
import { ParseResult, parseResultIsError, parse, stripResultIndexes, Leaf as AstLeaf } from './parser-combinator.js';
import {
    Type,
    TypeComponent,
    VariableDeclaration,
    Function,
    UninferredFunction,
    BackendInputs,
    ParseError,
    TypeError,
    StringLiteralData,
} from './api.js';
import * as Ast from './ast.js';

let tokensToString = tokens => tokens.map(token => token.string).join('');

const repairAssociativity = (nodeType, ast) => {
    // Let this slide because TokenType overlaps InteriorNodeType right now
    if (ast.type === nodeType && !ast.children) /*debug('todo')*/ return ast;
    if (ast.type === nodeType) {
        if (!ast.children[2]) debug('todo');
        if (ast.children[2].type === nodeType) {
            return {
                type: nodeType,
                children: [
                    {
                        type: nodeType,
                        children: [
                            repairAssociativity(nodeType, ast.children[0]),
                            ast.children[2].children[1],
                            repairAssociativity(nodeType, ast.children[2].children[0]),
                        ],
                        sourceLine: ast.sourceLine,
                        sourceColumn: ast.sourceColumn,
                    },
                    ast.children[1],
                    repairAssociativity(nodeType, ast.children[2].children[2]),
                ],
                sourceLine: ast.sourceLine,
                sourceColumn: ast.sourceColumn,
            };
        } else {
            return {
                type: ast.type,
                children: ast.children.map(child => repairAssociativity(nodeType, child)),
                sourceLine: ast.sourceLine,
                sourceColumn: ast.sourceColumn,
            };
        }
    } else if ('children' in ast) {
        return {
            type: ast.type,
            children: ast.children.map(child => repairAssociativity(nodeType, child)),
            sourceLine: ast.sourceLine,
            sourceColumn: ast.sourceColumn,
        };
    } else {
        return ast;
    }
};

const transformAst = (nodeType, f, ast: MplAst, recurseOnNew: boolean) => {
    if (ast.type === nodeType) {
        const newNode = f(ast);
        if ('children' in newNode) {
            // If we aren't supposed to recurse, don't re-tranform the node we just made
            if (recurseOnNew) {
                return transformAst(nodeType, f, newNode, recurseOnNew);
            } else {
                return {
                    type: newNode.type,
                    children: newNode.children.map(child => transformAst(nodeType, f, child, recurseOnNew)),
                    sourceLine: ast.sourceLine,
                    sourceColumn: ast.sourceColumn,
                };
            }
        } else {
            return newNode;
        }
    } else if ('children' in ast) {
        return {
            type: ast.type,
            children: ast.children.map(child => transformAst(nodeType, f, child, recurseOnNew)),
            sourceLine: ast.sourceLine,
            sourceColumn: ast.sourceColumn,
        };
    } else {
        return ast;
    }
};

const extractVariable = (
    statement: Ast.UninferredStatement,
    variablesInScope: VariableDeclaration[],
    isGlobal: boolean
): VariableDeclaration | undefined => {
    const result: VariableDeclaration[] = [];
    switch (statement.kind) {
        case 'reassignment':
        case 'declarationAssignment':
        case 'typedDeclarationAssignment':
            // Recursive functions can refer to the left side on the right side, so to extra
            // the left side, we need to know about the right side. Probably, this just shouldn't return
            // a type. TODO: allow more types of recursive functions than just single int...
            const variablesIncludingSelf = mergeDeclarations(variablesInScope, [
                {
                    name: statement.destination,
                    type: {
                        name: 'Function',
                        arguments: [{ name: 'Integer', arguments: [] }, { name: 'Integer', arguments: [] }],
                    },
                    location: isGlobal ? 'Global' : 'Stack',
                },
            ]);
            return {
                name: statement.destination,
                location: isGlobal ? 'Global' : 'Stack',
                type: typeOfExpression(statement.expression, variablesIncludingSelf) as Type,
            };
        case 'returnStatement':
            return undefined;
        default:
            throw debug('todo');
    }
};

const extractVariables = (
    statements: Ast.UninferredStatement[],
    variablesInScope: VariableDeclaration[]
): VariableDeclaration[] => {
    const variables: VariableDeclaration[] = [];
    statements.forEach((statement: Ast.UninferredStatement) => {
        switch (statement.kind) {
            case 'returnStatement':
            case 'reassignment':
                break;
            case 'declarationAssignment':
            case 'typedDeclarationAssignment':
                const potentialVariable = extractVariable(
                    statement,
                    mergeDeclarations(variablesInScope, variables),
                    false
                );
                if (potentialVariable) {
                    variables.push(potentialVariable);
                }
                break;
            default:
                throw debug('todo');
        }
    });
    return variables;
};

const functionObjectFromAst = (
    ast: Ast.UninferredFunctionLiteral,
    variablesInScope: VariableDeclaration[]
): UninferredFunction => ({
    name: ast.deanonymizedName,
    statements: ast.body,
    variables: [...ast.parameters, ...extractVariables(ast.body, mergeDeclarations(variablesInScope, ast.parameters))],
    parameters: ast.parameters,
});

const extractFunctions = (ast: Ast.UninferredAst, variablesInScope: VariableDeclaration[]): UninferredFunction[] => {
    const recurse = ast => extractFunctions(ast, variablesInScope);
    switch (ast.kind) {
        case 'returnStatement':
        case 'typedDeclarationAssignment':
        case 'declarationAssignment':
        case 'reassignment':
            return recurse(ast.expression);
        case 'product':
        case 'addition':
        case 'subtraction':
        case 'equality':
        case 'concatenation':
            return recurse(ast.lhs).concat(recurse(ast.rhs));
        case 'callExpression':
            return flatten(ast.arguments.map(recurse));
        case 'ternary':
            return recurse(ast.condition)
                .concat(recurse(ast.ifTrue))
                .concat(recurse(ast.ifFalse));
        case 'program':
            return flatten(ast.statements.map(recurse));
        case 'functionLiteral':
            return [functionObjectFromAst(ast, variablesInScope), ...flatten(ast.body.map(recurse))];
        case 'number':
        case 'identifier':
        case 'stringLiteral':
        case 'booleanLiteral':
            return [];
        default:
            throw debug(`${(ast as any).kind} unhandled in extractFunctions`);
    }
};

let stringLiteralId = 0;
const extractStringLiterals = (ast: Ast.UninferredAst): StringLiteralData[] => {
    switch (ast.kind) {
        case 'returnStatement':
        case 'typedDeclarationAssignment':
        case 'declarationAssignment':
        case 'reassignment':
            return extractStringLiterals(ast.expression);
        case 'product':
        case 'addition':
        case 'subtraction':
        case 'equality':
        case 'concatenation':
            return extractStringLiterals(ast.lhs).concat(extractStringLiterals(ast.rhs));
        case 'callExpression':
            return flatten(ast.arguments.map(extractStringLiterals));
        case 'ternary':
            return extractStringLiterals(ast.condition)
                .concat(extractStringLiterals(ast.ifTrue))
                .concat(extractStringLiterals(ast.ifFalse));
        case 'program':
            return flatten(ast.statements.map(extractStringLiterals));
        case 'functionLiteral':
            return flatten(ast.body.map(extractStringLiterals));
        case 'number':
        case 'identifier':
        case 'booleanLiteral':
            return [];
        case 'stringLiteral':
            stringLiteralId++;
            return [{ id: stringLiteralId, value: ast.value }];
        default:
            throw debug(`${(ast as any).kind} unhandled in extractStringLiterals`);
    }
};

const removeBracketsFromAst = ast => transformAst('bracketedExpression', node => node.children[1], ast, true);

const parseMpl = (tokens: Token<MplToken>[]): MplAst | ParseError[] => {
    const parseResult: MplParseResult = stripResultIndexes(parse(grammar, 'program', tokens, 0));

    if (parseResultIsError(parseResult)) {
        return [
            {
                kind: 'unexpectedToken',
                found: parseResult.found,
                expected: parseResult.expected,
                sourceLine: parseResult.sourceLine,
                sourceColumn: parseResult.sourceColumn,
            },
        ];
    }
    let ast = parseResult;

    ast = repairAssociativity('subtraction', ast);
    ast = repairAssociativity('addition', ast);
    ast = repairAssociativity('product', ast);

    // Bracketed expressions -> nothing. Must happen after associativity repair or we will break
    // associativity of brackets.
    ast = removeBracketsFromAst(ast);

    return ast;
};

const typesAreEqual = (a: Type, b: Type): boolean => {
    if (a.name != b.name) return false;
    if (a.arguments.length != b.arguments.length) return false;
    for (let i = 0; i < a.arguments.length; i++) {
        if (!typesAreEqual(a.arguments[i], b.arguments[i])) {
            return false;
        }
    }
    return true;
};

const isTypeError = (val: Type | Function | TypeError[]): val is TypeError[] => Array.isArray(val);

const combineErrors = (potentialErrors: (Type | TypeError[])[]): TypeError[] | null => {
    const result: TypeError[] = [];
    potentialErrors.forEach(e => {
        if (isTypeError(e)) {
            result.push(...e);
        }
    });
    return result.length > 0 ? result : null;
};

// TODO: It's kinda weird that this accepts an Uninferred AST. This function should maybe be merged with infer()
export const typeOfExpression = (
    ast: Ast.UninferredAst,
    variablesInScope: VariableDeclaration[]
): Type | TypeError[] => {
    switch (ast.kind) {
        case 'number':
            return builtinTypes.Integer;
        case 'addition':
        case 'product':
        case 'subtraction': {
            const leftType = typeOfExpression(ast.lhs, variablesInScope);
            const rightType = typeOfExpression(ast.rhs, variablesInScope);
            const combinedErrors = combineErrors([leftType, rightType]);
            if (combinedErrors) {
                return combinedErrors;
            }
            if (!typesAreEqual(leftType as Type, builtinTypes.Integer)) {
                return [
                    {
                        kind: 'wrongTypeForOperator',
                        operator: ast.kind,
                        expected: 'Integer',
                        found: leftType as Type,
                        side: 'left',
                        sourceLine: ast.sourceLine,
                        sourceColumn: ast.sourceColumn,
                    },
                ];
            }
            if (!typesAreEqual(rightType as Type, builtinTypes.Integer)) {
                return [
                    {
                        kind: 'wrongTypeForOperator',
                        operator: ast.kind,
                        expected: 'Integer',
                        found: rightType as Type,
                        side: 'right',
                        sourceLine: ast.sourceLine,
                        sourceColumn: ast.sourceColumn,
                    },
                ];
            }
            return builtinTypes.Integer;
        }
        case 'equality': {
            const leftType = typeOfExpression(ast.lhs, variablesInScope);
            const rightType = typeOfExpression(ast.rhs, variablesInScope);
            const combinedErrors = combineErrors([leftType, rightType]);
            if (combinedErrors) {
                return combinedErrors;
            }
            if (!typesAreEqual(leftType as Type, rightType as Type)) {
                return [
                    {
                        kind: 'typeMismatchForOperator',
                        leftType: leftType as Type,
                        rightType: rightType as Type,
                        operator: 'equality',
                        sourceLine: ast.sourceLine,
                        sourceColumn: ast.sourceColumn,
                    },
                ];
            }
            return builtinTypes.Boolean;
        }
        case 'concatenation': {
            const leftType = typeOfExpression(ast.lhs, variablesInScope);
            const rightType = typeOfExpression(ast.rhs, variablesInScope);
            const combinedErrors = combineErrors([leftType, rightType]);
            if (combinedErrors) {
                return combinedErrors;
            }
            if ((leftType as Type).name !== 'String') {
                return [
                    {
                        kind: 'wrongTypeForOperator',
                        found: leftType as Type,
                        expected: 'String',
                        operator: 'concatenation',
                        side: 'left',
                        sourceLine: ast.sourceLine,
                        sourceColumn: ast.sourceColumn,
                    },
                ];
            }
            if ((rightType as Type).name !== 'String') {
                return [
                    {
                        kind: 'wrongTypeForOperator',
                        found: rightType as Type,
                        expected: 'String',
                        operator: 'concatenation',
                        side: 'right',
                        sourceLine: ast.sourceLine,
                        sourceColumn: ast.sourceColumn,
                    },
                ];
            }
            return builtinTypes.String;
        }
        case 'functionLiteral':
            const f = inferFunction(functionObjectFromAst(ast, variablesInScope), variablesInScope);
            if (isTypeError(f)) {
                return f;
            }
            return {
                name: 'Function',
                arguments: [...ast.parameters.map(p => p.type), f.returnType],
            };
        case 'callExpression': {
            const argTypes: (Type | TypeError[])[] = ast.arguments.map(argument =>
                typeOfExpression(argument, variablesInScope)
            );
            const argTypeErrors: TypeError[] = [];
            argTypes.forEach(argType => {
                if (isTypeError(argType)) {
                    argTypeErrors.push(...argType);
                }
            });
            if (argTypeErrors.length > 0) {
                return argTypeErrors;
            }
            const functionName = ast.name;
            const declaration = variablesInScope.find(({ name }) => functionName == name);
            if (!declaration) {
                return [
                    {
                        kind: 'unknownIdentifier',
                        name: functionName,
                        sourceLine: ast.sourceLine,
                        sourceColumn: ast.sourceColumn,
                    },
                ];
            }
            const functionType = declaration.type;
            if (functionType.name !== 'Function') {
                return [
                    {
                        kind: 'calledNonFunction',
                        identifierName: functionName,
                        actualType: functionType,
                        sourceLine: ast.sourceLine,
                        sourceColumn: ast.sourceColumn,
                    },
                ];
            }
            if (argTypes.length !== functionType.arguments.length - 1) {
                return [
                    {
                        kind: 'wrongNumberOfArguments',
                        targetFunction: functionName,
                        passedArgumentCount: argTypes.length,
                        expectedArgumentCount: declaration.type.arguments.length - 1,
                        sourceLine: ast.sourceLine,
                        sourceColumn: ast.sourceColumn,
                    },
                ];
            }
            for (let i = 0; i < argTypes.length; i++) {
                if (!typesAreEqual(argTypes[i] as Type, functionType.arguments[i])) {
                    return [
                        {
                            kind: 'wrongArgumentType',
                            targetFunction: functionName,
                            passedType: argTypes[i] as Type,
                            expectedType: functionType.arguments[i],
                            sourceLine: ast.sourceLine,
                            sourceColumn: ast.sourceColumn,
                        } as TypeError,
                    ];
                }
            }
            const maybeReturnType = last(functionType.arguments);
            if (!maybeReturnType) {
                throw debug('Function had no return type');
            }
            return maybeReturnType;
        }
        case 'identifier': {
            const declaration = variablesInScope.find(({ name }) => ast.value == name);
            if (!declaration) {
                return [
                    {
                        kind: 'unknownTypeForIdentifier',
                        identifierName: ast.value,
                        sourceLine: ast.sourceLine,
                        sourceColumn: ast.sourceColumn,
                    },
                ];
            }
            return declaration.type;
        }
        case 'ternary': {
            const conditionType = typeOfExpression(ast.condition, variablesInScope);
            const trueBranchType = typeOfExpression(ast.ifTrue, variablesInScope);
            const falseBranchType = typeOfExpression(ast.ifFalse, variablesInScope);
            const combinedErrors = combineErrors([conditionType, trueBranchType, falseBranchType]);
            if (combinedErrors) {
                return combinedErrors;
            }
            if (!typesAreEqual(conditionType as Type, builtinTypes.Boolean)) {
                return [
                    {
                        kind: 'wrongTypeForOperator',
                        found: (conditionType as any).name,
                        expected: 'Boolean',
                        operator: 'Ternary',
                        side: 'left',
                        sourceLine: ast.sourceLine,
                        sourceColumn: ast.sourceColumn,
                    },
                ];
            }
            if (!typesAreEqual(trueBranchType as Type, falseBranchType as Type)) {
                return [
                    {
                        kind: 'ternaryBranchMismatch',
                        trueBranchType: trueBranchType,
                        falseBranchType: falseBranchType,
                        sourceLine: ast.sourceLine,
                        sourceColumn: ast.sourceColumn,
                    } as TypeError,
                ];
            }
            return trueBranchType;
        }
        case 'booleanLiteral':
            return builtinTypes.Boolean;
        case 'stringLiteral':
            return builtinTypes.String;
        case 'returnStatement':
            return typeOfExpression(ast.expression, variablesInScope);
        default:
            throw debug(`${ast.kind} unhandled in typeOfExpression`);
    }
};

const typeToString = (type: Type): string => {
    if (type.arguments.length == 0) return type.name;
    return type.name + '<' + join(type.arguments.map(typeToString), ', ') + '>';
};

const typeCheckStatement = (
    ast: Ast.UninferredAst,
    variablesInScope: VariableDeclaration[]
): { errors: TypeError[]; newVariables: VariableDeclaration[] } => {
    if (!ast.kind) debug('!ast.kind');
    switch (ast.kind) {
        case 'returnStatement': {
            const result = typeOfExpression(ast.expression, variablesInScope);
            if (isTypeError(result)) {
                return { errors: result, newVariables: [] };
            }
            return { errors: [], newVariables: [] };
        }
        case 'declarationAssignment': {
            const rightType = typeOfExpression(
                ast.expression,
                mergeDeclarations(variablesInScope, [
                    {
                        name: ast.destination,
                        type: {
                            name: 'Function',
                            arguments: [{ name: 'Integer', arguments: [] }, { name: 'Integer', arguments: [] }],
                        },
                        location: 'Stack',
                    },
                ])
            );
            if (isTypeError(rightType)) {
                return { errors: rightType, newVariables: [] };
            }
            // Left type is inferred as right type
            return {
                errors: [],
                newVariables: [{ name: ast.destination, type: rightType, location: 'FAKE' as any }],
            };
        }
        case 'reassignment': {
            const rightType = typeOfExpression(ast.expression, variablesInScope);
            if (isTypeError(rightType)) {
                return { errors: rightType, newVariables: [] };
            }
            const leftType = variablesInScope.find(v => v.name == ast.destination);
            if (!leftType) {
                return {
                    errors: [
                        {
                            kind: 'assignUndeclaredIdentifer',
                            destinationName: ast.destination,
                            sourceLine: ast.sourceLine,
                            sourceColumn: ast.sourceColumn,
                        },
                    ],
                    newVariables: [],
                };
            }
            if (!typesAreEqual(leftType.type, rightType)) {
                return {
                    errors: [
                        {
                            kind: 'assignWrongType',
                            lhsName: ast.destination,
                            lhsType: leftType.type,
                            rhsType: rightType,
                            sourceLine: ast.sourceLine,
                            sourceColumn: ast.sourceColumn,
                        },
                    ],
                    newVariables: [],
                };
            }
            return { errors: [], newVariables: [] };
        }
        case 'typedDeclarationAssignment': {
            // Check that type of var being assigned to matches type being assigned
            const expressionType = typeOfExpression(
                ast.expression,
                mergeDeclarations(variablesInScope, [
                    {
                        name: ast.destination,
                        type: {
                            name: 'Function',
                            arguments: [{ name: 'Integer', arguments: [] }, { name: 'Integer', arguments: [] }],
                        },
                        location: 'Stack',
                    },
                ])
            );
            const destinationType = ast.type;
            if (isTypeError(expressionType)) {
                return { errors: expressionType, newVariables: [] };
            }
            if (!typesAreEqual(expressionType, destinationType)) {
                return {
                    errors: [
                        {
                            kind: 'assignWrongType',
                            lhsName: ast.destination,
                            lhsType: destinationType,
                            rhsType: expressionType,
                            sourceLine: ast.sourceLine,
                            sourceColumn: ast.sourceColumn,
                        },
                    ],
                    newVariables: [],
                };
            }
            return {
                errors: [],
                newVariables: [{ name: ast.destination, type: destinationType, location: 'Stack' }],
            };
        }
        default:
            throw debug(`${ast.kind} unhandled in typeCheckStatement`);
    }
};

export const builtinTypes: { [index: string]: Type } = {
    String: { name: 'String', arguments: [] },
    Integer: { name: 'Integer', arguments: [] },
    Boolean: { name: 'Boolean', arguments: [] },
};
// TODO: Require these to be imported in user code
export const builtinFunctions: VariableDeclaration[] = [
    {
        name: 'length',
        type: {
            name: 'Function',
            arguments: [builtinTypes.String, builtinTypes.Integer],
        },
        location: 'Global',
    },
    {
        name: 'print',
        type: {
            name: 'Function',
            arguments: [builtinTypes.String, builtinTypes.Integer],
        },
        location: 'Global',
    },
];

const mergeDeclarations = (left: VariableDeclaration[], right: VariableDeclaration[]): VariableDeclaration[] => {
    const result = [...right];
    left.forEach(declaration => {
        if (!result.some(({ name }) => name == declaration.name)) {
            result.unshift(declaration);
        }
    });
    return result;
};

const typeCheckFunction = (f: UninferredFunction, variablesInScope: VariableDeclaration[]) => {
    variablesInScope = mergeDeclarations(variablesInScope, f.parameters);
    const allErrors: any = [];
    f.statements.forEach(statement => {
        if (allErrors.length == 0) {
            const { errors, newVariables } = typeCheckStatement(statement, variablesInScope);
            variablesInScope = mergeDeclarations(variablesInScope, newVariables);
            allErrors.push(...errors);
        }
    });
    return { typeErrors: allErrors, identifiers: variablesInScope };
};

const getFunctionTypeMap = (functions: UninferredFunction[]): VariableDeclaration[] =>
    functions.map(({ name, parameters }) => ({
        name: name,
        type: { name: 'Function' as 'Function', arguments: parameters.map(p => p.type) },
        location: 'Global' as 'Global',
    }));

const assignmentToGlobalDeclaration = (
    ast: Ast.UninferredDeclarationAssignment,
    variablesInScope: VariableDeclaration[]
): VariableDeclaration => {
    const result = typeOfExpression(ast.expression, variablesInScope);
    if (isTypeError(result)) throw debug('isTypeError in assignmentToGlobalDeclaration');
    return {
        name: ast.destination,
        type: result,
        location: 'Global',
    };
};

const inferFunction = (f: UninferredFunction, variablesInScope: VariableDeclaration[]): Function | TypeError[] => {
    let variablesFound = mergeDeclarations(variablesInScope, f.parameters);
    f.statements.forEach(s => {
        const maybeNewVariable = extractVariable(s, variablesFound, false);
        if (maybeNewVariable) {
            variablesFound.push(maybeNewVariable);
        }
    });
    const maybeReturnStatement = last(f.statements);
    if (!maybeReturnStatement || maybeReturnStatement.kind != 'returnStatement') {
        throw debug('Missing returnStatement');
    }
    const returnStatement = maybeReturnStatement;
    const returnType = typeOfExpression(returnStatement, variablesFound);
    if (isTypeError(returnType)) {
        return returnType;
    }
    return {
        name: f.name,
        statements: f.statements.map(s => infer(s, variablesFound)) as Ast.Statement[],
        variables: f.variables,
        parameters: f.parameters,
        returnType: returnType,
    };
};

const infer = (ast: Ast.UninferredAst, variablesInScope: VariableDeclaration[]): Ast.Ast => {
    const recurse = ast => infer(ast, variablesInScope);
    switch (ast.kind) {
        case 'returnStatement':
            return { kind: 'returnStatement', expression: recurse(ast.expression) };
        case 'equality':
            return {
                kind: 'equality',
                lhs: recurse(ast.lhs),
                rhs: recurse(ast.rhs),
                type: typeOfExpression(ast.lhs, variablesInScope) as Type,
            };
        case 'product':
            return {
                kind: ast.kind,
                lhs: recurse(ast.lhs),
                rhs: recurse(ast.rhs),
            };
        case 'addition':
            return {
                kind: ast.kind,
                lhs: recurse(ast.lhs),
                rhs: recurse(ast.rhs),
            };
        case 'subtraction':
            return {
                kind: ast.kind,
                lhs: recurse(ast.lhs),
                rhs: recurse(ast.rhs),
            };
        case 'concatenation':
            return {
                kind: ast.kind,
                lhs: recurse(ast.lhs),
                rhs: recurse(ast.rhs),
            };
        case 'typedDeclarationAssignment':
            return {
                kind: 'typedDeclarationAssignment',
                expression: recurse(ast.expression),
                type: ast.type,
                destination: ast.destination,
            };
        case 'declarationAssignment':
            return {
                kind: 'typedDeclarationAssignment',
                expression: recurse(ast.expression),
                type: typeOfExpression(ast.expression, variablesInScope) as Type,
                destination: ast.destination,
            };
        case 'reassignment':
            return {
                kind: 'reassignment',
                expression: recurse(ast.expression),
                destination: ast.destination,
            };
        case 'callExpression':
            return {
                kind: 'callExpression',
                name: ast.name,
                arguments: ast.arguments.map(recurse),
            };
        case 'ternary':
            return {
                kind: 'ternary',
                condition: recurse(ast.condition),
                ifTrue: recurse(ast.ifTrue),
                ifFalse: recurse(ast.ifFalse),
            };
        case 'functionLiteral':
            return {
                kind: 'functionLiteral',
                deanonymizedName: ast.deanonymizedName,
            };
        case 'number':
        case 'identifier':
        case 'booleanLiteral':
        case 'stringLiteral':
            return ast;
        default:
            throw debug(`${ast.kind} unhandled in infer`);
    }
};

type FrontendOutput = BackendInputs | { parseErrors: ParseError[] } | { typeErrors: TypeError[] };

const makeProgramAstNodeFromStatmentParseResult = (ast): Ast.UninferredStatement[] => {
    const children: Ast.UninferredStatement[] = [];
    if (ast.type === 'statement') {
        children.push(astFromParseResult(ast.children[0]) as Ast.UninferredStatement);
        children.push(...makeProgramAstNodeFromStatmentParseResult(ast.children[2]));
    } else {
        children.push(astFromParseResult(ast) as Ast.UninferredStatement);
    }
    return children;
};

const extractFunctionBodyFromParseTree = node => {
    switch (node.type) {
        case 'returnStatement':
            return [astFromParseResult(node)];
        case 'statement':
            return [astFromParseResult(node.children[0]), ...extractFunctionBodyFromParseTree(node.children[2])];
        default:
            throw debug(`${node.type} unhandled in extractFunctionBodyFromParseTree`);
    }
};

// TODO: Unify extractParameterList, extractArgumentList, extractTypeList
const extractArgumentList = (ast: MplAst): MplAst[] => {
    switch (ast.type) {
        case 'paramList':
            return [ast.children[0], ...extractArgumentList(ast.children[2])];
        default:
            return [ast];
    }
};

const extractParameterList = (ast: MplAst): VariableDeclaration[] => {
    if (ast.type == 'arg') {
        if (ast.children[2].type == 'typeWithoutArgs') {
            return [
                {
                    name: (ast.children[0] as AstLeaf<MplToken>).value as string,
                    type: parseType(ast.children[2]),
                    location: 'Parameter',
                },
            ];
        } else {
            throw debug('wrong children length');
        }
    } else if (ast.type == 'argList') {
        return [...extractParameterList(ast.children[0]), ...extractParameterList(ast.children[2])];
    } else if (ast.type == 'bracketedArgList') {
        if (ast.children.length > 2) {
            return extractParameterList(ast.children[1]);
        } else {
            return [];
        }
    } else {
        throw debug(`${ast.type} unhandledi extractParameterList`);
    }
};

const extractTypeList = (ast: MplAst): Type[] => {
    switch (ast.type) {
        case 'typeList':
            return [parseType(ast.children[0]), ...extractTypeList(ast.children[2])];
        default:
            return [parseType(ast)];
    }
};

const parseTypeLiteralComponent = (ast: MplAst): TypeComponent => {
    if (ast.type != 'typeLiteralComponent') throw debug('wrong as type');
    return {
        name: (ast.children[0] as any).value,
        type: parseType(ast.children[2]),
    };
};

const parseType = (ast: MplAst): Type => {
    switch (ast.type) {
        case 'typeWithArgs':
            return {
                name: (ast.children[0] as any).value,
                arguments: extractTypeList(ast.children[2]),
            };
        case 'typeWithoutArgs':
            return {
                name: (ast.children[0] as any).value,
                arguments: [],
            };
        case 'typeLiteral':
            return {
                name: 'UserDefined',
                arguments: [],
                members: (ast.children[1] as any).children.map(parseTypeLiteralComponent),
            };
        default:
            throw debug(`${ast.type} unhandled in parseType`);
    }
};

let functionId = 0;
const astFromParseResult = (ast: MplAst): Ast.UninferredAst | 'WrongShapeAst' => {
    switch (ast.type) {
        case 'returnStatement':
            return {
                kind: 'returnStatement',
                expression: astFromParseResult(ast.children[1]),
                sourceLine: ast.sourceLine,
                sourceColumn: ast.sourceColumn,
            } as Ast.UninferredAst;
        case 'number':
            if (ast.value === undefined) throw debug('ast.value === undefined');
            return {
                kind: 'number',
                value: ast.value as any,
                sourceLine: ast.sourceLine,
                sourceColumn: ast.sourceColumn,
            };
        case 'identifier':
            if (!ast.value) throw debug('!ast.value');
            return {
                kind: 'identifier',
                value: ast.value as any,
                sourceLine: ast.sourceLine,
                sourceColumn: ast.sourceColumn,
            };
        case 'product':
            if (!('children' in ast)) throw debug('children not in ast in astFromParseResult');
            return {
                kind: 'product',
                lhs: astFromParseResult(ast.children[0]),
                rhs: astFromParseResult(ast.children[2]),
                sourceLine: ast.sourceLine,
                sourceColumn: ast.sourceColumn,
            } as Ast.UninferredAst;
        case 'ternary':
            return {
                kind: 'ternary',
                condition: astFromParseResult(ast.children[0]),
                ifTrue: astFromParseResult(ast.children[2]),
                ifFalse: astFromParseResult(ast.children[4]),
                sourceLine: ast.sourceLine,
                sourceColumn: ast.sourceColumn,
            } as Ast.UninferredAst;
        case 'equality':
            if (!('children' in ast)) throw debug('children not in ast in astFromParseResult');
            return {
                kind: 'equality',
                lhs: astFromParseResult(ast.children[0]),
                rhs: astFromParseResult(ast.children[2]),
                sourceLine: ast.sourceLine,
                sourceColumn: ast.sourceColumn,
            } as Ast.UninferredAst;
        case 'paramList':
            throw debug('paramList in astFromParseResult'); //Should have been caught in "callExpression"
        case 'callExpression':
            const args =
                ast.children[2].type == 'rightBracket'
                    ? []
                    : extractArgumentList(ast.children[2]).map(astFromParseResult);
            return {
                kind: 'callExpression',
                name: (ast.children[0] as any).value as any,
                arguments: args,
                sourceLine: ast.sourceLine,
                sourceColumn: ast.sourceColumn,
            } as Ast.UninferredAst;
        case 'subtraction':
            if (!('children' in ast)) throw debug('children not in ast in astFromParseResult');
            return {
                kind: 'subtraction',
                lhs: astFromParseResult(ast.children[0]),
                rhs: astFromParseResult(ast.children[2]),
                sourceLine: ast.sourceLine,
                sourceColumn: ast.sourceColumn,
            } as Ast.UninferredAst;
        case 'addition':
            if (!('children' in ast)) throw debug('children not in ast in astFromParseResult');
            return {
                kind: 'addition',
                lhs: astFromParseResult(ast.children[0]),
                rhs: astFromParseResult(ast.children[2]),
                sourceLine: ast.sourceLine,
                sourceColumn: ast.sourceColumn,
            } as Ast.UninferredAst;
        case 'reassignment':
            if (!('children' in ast)) throw debug('children not in ast in astFromParseResult');
            return {
                kind: 'reassignment',
                destination: (ast.children[0] as any).value as any,
                expression: astFromParseResult(ast.children[2]),
                sourceLine: ast.sourceLine,
                sourceColumn: ast.sourceColumn,
            } as Ast.UninferredAst;
        case 'declarationAssignment':
            if (!('children' in ast)) throw debug('children not in ast in astFromParseResult');
            return {
                kind: 'declarationAssignment',
                destination: (ast.children[0] as any).value as any,
                expression: astFromParseResult(ast.children[3]),
                sourceLine: ast.sourceLine,
                sourceColumn: ast.sourceColumn,
            } as Ast.UninferredAst;
        case 'typedDeclarationAssignment':
            if (!('children' in ast)) throw debug('children not in ast in astFromParseResult');
            return {
                kind: 'typedDeclarationAssignment',
                destination: (ast.children[0] as any).value as any,
                type: parseType(ast.children[2]),
                expression: astFromParseResult(ast.children[4]),
                sourceLine: ast.sourceLine,
                sourceColumn: ast.sourceColumn,
            } as Ast.UninferredAst;
        case 'typeDeclaration':
            return {
                kind: 'typeDeclaration',
                name: (ast.children[0] as any).value,
                type: parseType(ast.children[3]),
                sourceLine: ast.sourceLine,
                sourceColumn: ast.sourceColumn,
            } as Ast.UninferredAst;
        case 'stringLiteral':
            return {
                kind: 'stringLiteral',
                value: ast.value as any,
                sourceLine: ast.sourceLine,
                sourceColumn: ast.sourceColumn,
            };
        case 'objectLiteral':
            throw debug('todo');
        case 'concatenation':
            if (!('children' in ast)) throw debug('children not in ast in astFromParseResult');
            return {
                kind: 'concatenation',
                lhs: astFromParseResult(ast.children[0]),
                rhs: astFromParseResult(ast.children[2]),
                sourceLine: ast.sourceLine,
                sourceColumn: ast.sourceColumn,
            } as Ast.UninferredAst;
        case 'equality':
            if (!('children' in ast)) throw debug('children not in ast in astFromParseResult');
            return {
                kind: 'equality',
                lhs: astFromParseResult(ast.children[0]),
                rhs: astFromParseResult(ast.children[2]),
                sourceLine: ast.sourceLine,
                sourceColumn: ast.sourceColumn,
            } as Ast.UninferredAst;
        case 'function':
            functionId++;
            const parameters: VariableDeclaration[] = extractParameterList(ast.children[0]);
            return {
                kind: 'functionLiteral',
                deanonymizedName: `anonymous_${functionId}`,
                body: [
                    {
                        kind: 'returnStatement',
                        expression: astFromParseResult(ast.children[2]),
                        sourceLine: ast.sourceLine,
                        sourceColumn: ast.sourceColumn,
                    },
                ],
                parameters,
                sourceLine: ast.sourceLine,
                sourceColumn: ast.sourceColumn,
            } as Ast.UninferredAst;
        case 'functionWithBlock':
            functionId++;
            const parameters2: VariableDeclaration[] = extractParameterList(ast.children[0]);
            return {
                kind: 'functionLiteral',
                deanonymizedName: `anonymous_${functionId}`,
                body: extractFunctionBodyFromParseTree(ast.children[3]),
                parameters: parameters2,
                sourceLine: ast.sourceLine,
                sourceColumn: ast.sourceColumn,
            };
        case 'booleanLiteral':
            return {
                kind: 'booleanLiteral',
                value: ast.value == 'true',
                sourceLine: ast.sourceLine,
                sourceColumn: ast.sourceColumn,
            };
        case 'program':
            return {
                kind: 'program',
                statements: makeProgramAstNodeFromStatmentParseResult(ast.children[0]),
                sourceLine: ast.sourceLine,
                sourceColumn: ast.sourceColumn,
            };
        default:
            throw debug(`${ast.type} unhandled in astFromParseResult`);
    }
};

const parseErrorToString = (e: ParseError): string => {
    switch (e.kind) {
        case 'unexpectedProgram':
            return 'Failed to parse. Top Level of AST was not a program.';
        case 'unexpectedToken':
            return `Expected ${e.expected.join(' or ')}, on line ${e.sourceLine} column ${e.sourceColumn}, found ${
                e.found
            }`;
        default:
            throw debug('Unhandled error in parseErrorToString');
    }
};

const compile = (source: string): FrontendOutput => {
    stringLiteralId = 0; // Hacky, too much global state.
    const tokens = lex<MplToken>(tokenSpecs, source);
    const parseResult = parseMpl(tokens);

    if (Array.isArray(parseResult)) {
        return { parseErrors: parseResult };
    }

    const ast = astFromParseResult(parseResult);

    if (ast == 'WrongShapeAst') {
        return {
            parseErrors: [
                {
                    kind: 'unexpectedToken',
                    expected: ['InternalError'],
                    found: ['InternalError'],
                    sourceLine: 0,
                    sourceColumn: 0,
                },
            ],
        };
    }

    if (ast.kind !== 'program') {
        return { parseErrors: [{ kind: 'unexpectedProgram' }] };
    }

    let variablesInScope = builtinFunctions;
    const program: UninferredFunction = {
        name: `main_program`,
        statements: ast.statements,
        variables: extractVariables(ast.statements, variablesInScope),
        parameters: [],
    };

    const functions = extractFunctions(ast, builtinFunctions);
    const stringLiterals: StringLiteralData[] = uniqueBy(s => s.value, extractStringLiterals(ast));
    variablesInScope = mergeDeclarations(variablesInScope, getFunctionTypeMap(functions));
    const programTypeCheck = typeCheckFunction(program, variablesInScope);
    variablesInScope = mergeDeclarations(variablesInScope, programTypeCheck.identifiers);

    let typeErrors: TypeError[][] = functions.map(f => typeCheckFunction(f, variablesInScope).typeErrors);
    typeErrors.push(programTypeCheck.typeErrors);

    const typedProgramStatements = program.statements.map(s => infer(s, variablesInScope));

    let flatTypeErrors: TypeError[] = flatten(typeErrors);
    if (flatTypeErrors.length > 0) {
        return { typeErrors: flatTypeErrors };
    }

    const typedFunctions: Function[] = [];
    functions.forEach(f => {
        const functionOrTypeError = inferFunction(f, variablesInScope);
        if (isTypeError(functionOrTypeError)) {
            typeErrors.push(functionOrTypeError);
        } else {
            typedFunctions.push({
                ...f,
                returnType: functionOrTypeError.returnType,
                statements: f.statements.map(s =>
                    infer(s, mergeDeclarations(variablesInScope, f.variables))
                ) as Ast.Statement[],
            });
        }
    });

    flatTypeErrors = flatten(typeErrors);
    if (flatTypeErrors.length > 0) {
        return { typeErrors: flatTypeErrors };
    }

    const globalDeclarations: VariableDeclaration[] = program.statements
        .filter(s => s.kind === 'typedDeclarationAssignment' || s.kind === 'declarationAssignment')
        .map(assignment => assignmentToGlobalDeclaration(assignment as any, variablesInScope));

    const inferredProgram = inferFunction(program, variablesInScope);
    if (isTypeError(inferredProgram)) {
        return { typeErrors: inferredProgram };
    }

    if (!typesAreEqual(inferredProgram.returnType, builtinTypes.Integer)) {
        return {
            typeErrors: [
                {
                    kind: 'wrongTypeReturn',
                    expressionType: inferredProgram.returnType,
                    sourceLine: 1,
                    sourceColumn: 1,
                },
            ],
        };
    }

    return {
        functions: typedFunctions,
        program: inferredProgram,
        globalDeclarations,
        stringLiterals,
    };
};

export {
    parseMpl,
    lex,
    compile,
    removeBracketsFromAst,
    typeCheckStatement,
    parseErrorToString,
    astFromParseResult,
    mergeDeclarations,
};
