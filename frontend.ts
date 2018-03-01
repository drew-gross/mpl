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
    VariableDeclaration,
    Function,
    UninferredFunction,
    MemoryCategory,
    BackendInputs,
    ParseError,
    TypeError,
    StringLiteralData,
} from './api.js';
import * as Ast from './ast.js';

let tokensToString = tokens => tokens.map(token => token.string).join('');

const repairAssociativity = (nodeTypeToRepair, ast) => {
    if (!ast) debug();
    // Let this slide because TokenType overlaps InteriorNodeType right now
    if (ast.type === nodeTypeToRepair && !ast.children) /*debug()*/ return ast;
    if (ast.type === nodeTypeToRepair) {
        if (!ast.children[2]) debug();
        if (ast.children[2].type === nodeTypeToRepair) {
            return {
                type: nodeTypeToRepair,
                children: [
                    {
                        type: nodeTypeToRepair,
                        children: [
                            repairAssociativity(nodeTypeToRepair, ast.children[0]),
                            ast.children[2].children[1],
                            repairAssociativity(nodeTypeToRepair, ast.children[2].children[0]),
                        ],
                    },
                    ast.children[1],
                    repairAssociativity(nodeTypeToRepair, ast.children[2].children[2]),
                ],
            };
        } else {
            return {
                type: ast.type,
                children: ast.children.map(child => repairAssociativity(nodeTypeToRepair, child)),
            };
        }
    } else if ('children' in ast) {
        return {
            type: ast.type,
            children: ast.children.map(child => repairAssociativity(nodeTypeToRepair, child)),
        };
    } else {
        return ast;
    }
};

const transformAst = (nodeType, f, ast: MplAst, recurseOnNew: boolean) => {
    if (!ast) debug();
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
                };
            }
        } else {
            return newNode;
        }
    } else if ('children' in ast) {
        return {
            type: ast.type,
            children: (ast as any).children.map(child => transformAst(nodeType, f, child, recurseOnNew)),
        };
    } else {
        return ast;
    }
};

const extractVariables = (
    statement: Ast.UninferredStatement,
    variablesInScope: VariableDeclaration[],
    isGlobal: boolean
): VariableDeclaration[] => {
    const result: VariableDeclaration[] = [];
    switch (statement.kind) {
        case 'assignment':
        case 'typedAssignment':
            return [
                {
                    name: statement.destination,
                    memoryCategory: isGlobal ? 'GlobalStatic' : 'Stack',
                    type: typeOfExpression(statement.expression, variablesInScope) as Type,
                },
            ];
        case 'returnStatement':
            return [];
        default:
            throw debug();
    }
};

const extractFunctions = (ast: Ast.UninferredAst, variablesInScope: VariableDeclaration[]): UninferredFunction[] => {
    const recurse = ast => extractFunctions(ast, variablesInScope);
    switch (ast.kind) {
        case 'returnStatement':
        case 'typedAssignment':
        case 'assignment':
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
            functionId++;
            const variables: VariableDeclaration[] = [...ast.parameters];
            ast.body.forEach((statement: Ast.UninferredStatement) => {
                switch (statement.kind) {
                    case 'returnStatement':
                        break;
                    case 'assignment':
                    case 'typedAssignment':
                        variables.push(
                            ...extractVariables(statement, mergeDeclarations(variablesInScope, variables), false)
                        );
                        break;
                    default:
                        throw debug();
                }
            });
            return flatten([
                [
                    {
                        name: ast.deanonymizedName,
                        statements: ast.body,
                        variables,
                        parameters: ast.parameters,
                        temporaryCount: Math.max(...ast.body.map(countTemporariesInExpression)),
                    },
                ],
                ...ast.body.map(recurse),
            ]);
        case 'number':
        case 'identifier':
        case 'stringLiteral':
        case 'booleanLiteral':
            return [];
        default:
            throw debug();
    }
};

let stringLiteralId = 0;
const extractStringLiterals = (ast: Ast.UninferredAst): StringLiteralData[] => {
    switch (ast.kind) {
        case 'returnStatement':
        case 'typedAssignment':
        case 'assignment':
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
            throw debug();
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

const countTemporariesInExpression = (ast: Ast.UninferredAst) => {
    switch (ast.kind) {
        case 'returnStatement':
            return countTemporariesInExpression(ast.expression);
        case 'product':
        case 'addition':
        case 'subtraction':
        case 'equality':
        case 'concatenation':
            return 1 + Math.max(countTemporariesInExpression(ast.lhs), countTemporariesInExpression(ast.rhs));
        case 'typedAssignment':
            return 1;
        case 'assignment':
            return 1;
        case 'callExpression':
            return 1;
        case 'ternary':
            return (
                2 +
                Math.max(
                    countTemporariesInExpression(ast.condition),
                    countTemporariesInExpression(ast.ifTrue),
                    countTemporariesInExpression(ast.ifFalse)
                )
            );
        case 'program':
            return Math.max(...ast.statements.map(countTemporariesInExpression));
        case 'number':
        case 'identifier':
        case 'booleanLiteral':
        case 'stringLiteral':
            return 0;
        default:
            debug();
    }
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

const isTypeError = (val: Type | TypeError[]): val is TypeError[] => Array.isArray(val);

const combineErrors = (potentialErrors: (Type | TypeError[])[]): TypeError[] | null => {
    const result: TypeError[] = [];
    potentialErrors.forEach(e => {
        if (isTypeError(e)) {
            result.push(...e);
        }
    });
    return result.length > 0 ? result : null;
};

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
                return [`Left hand side of ${ast.kind} was not integer`];
            }
            if (!typesAreEqual(rightType as Type, builtinTypes.Integer)) {
                return [`Right hand side of ${ast.kind} was not integer`];
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
                    `Equality comparisons must compare values of the same type.. You tried to compare a ${
                        (leftType as Type).name
                    } (lhs) with a ${(rightType as Type).name} (rhs)`,
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
            if ((leftType as Type).name !== 'String' || (rightType as Type).name !== 'String') {
                return ['Only strings can be concatenated right now'];
            }
            return builtinTypes.String;
        }
        case 'functionLiteral':
            return {
                name: 'Function',
                arguments: [...ast.parameters.map(p => p.type), builtinTypes.Integer],
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
                return [`Unknown identifier: ${functionName}`];
            }
            const functionType = declaration.type;
            if (functionType.name !== 'Function') {
                return [`You tried to call ${functionName}, but it's not a function (it's a ${functionType})`];
            }
            if (argTypes.length !== functionType.arguments.length - 1) {
                return [
                    `You tried to call ${functionName} with ${argTypes.length} arguments when it needs ${declaration
                        .type.arguments.length - 1}`,
                ];
            }
            for (let i = 0; i < argTypes.length; i++) {
                if (!typesAreEqual(argTypes[i] as Type, functionType.arguments[i])) {
                    return [
                        `You passed a ${(argTypes[i] as Type).name} as an argument to ${functionName}. It expects a ${
                            functionType.arguments[i].name
                        }`,
                    ];
                }
            }
            return builtinTypes.Integer;
        }
        case 'identifier': {
            const declaration = variablesInScope.find(({ name }) => ast.value == name);
            if (!declaration) {
                return [`Identifier ${ast.value} has unknown type.`];
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
                    `You tried to use a ${
                        (conditionType as any).name
                    } as the condition in a ternary. Boolean is required`,
                ];
            }
            if (!typesAreEqual(trueBranchType as Type, falseBranchType as Type)) {
                return [
                    `Type mismatch in branches of ternary. True branch had ${
                        (trueBranchType as any).name
                    }, false branch had ${(falseBranchType as any).name}.`,
                ];
            }
            return trueBranchType;
        }
        case 'booleanLiteral':
            return builtinTypes.Boolean;
        case 'stringLiteral':
            return builtinTypes.String;
        default:
            throw debug();
    }
};

const typeToString = (type: Type): string => {
    if (type.arguments.length == 0) return type.name;
    return type.name + '<' + join(type.arguments.map(typeToString), ', ') + '>';
};

const typeCheckStatement = (
    ast: Ast.UninferredAst,
    variablesInScope: VariableDeclaration[]
): { errors: string[]; newVariables: VariableDeclaration[] } => {
    if (!ast.kind) debug();
    switch (ast.kind) {
        case 'returnStatement': {
            const result = typeOfExpression(ast.expression, variablesInScope);
            if (isTypeError(result)) {
                return { errors: result, newVariables: [] };
            }
            if (!typesAreEqual(result, builtinTypes.Integer)) {
                return {
                    errors: [`You tried to return a ${result.name}`],
                    newVariables: [],
                };
            }
            return { errors: [], newVariables: [] };
        }
        case 'assignment': {
            const rightType = typeOfExpression(ast.expression, variablesInScope);
            if (isTypeError(rightType)) {
                return { errors: rightType, newVariables: [] };
            }
            // Left type is inferred as right type
            return {
                errors: [],
                newVariables: [{ name: ast.destination, type: rightType, memoryCategory: 'FAKE' as any }],
            };
        }
        case 'typedAssignment': {
            // Check that type of var being assigned to matches type being assigned
            const expressionType = typeOfExpression(ast.expression, variablesInScope);
            const destinationType = ast.type;
            if (isTypeError(expressionType)) {
                return { errors: expressionType, newVariables: [] };
            }
            if (!typesAreEqual(expressionType, destinationType)) {
                return {
                    errors: [
                        `You tried to assign a ${typeToString(expressionType)} to "${
                            ast.destination
                        }", which has type ${typeToString(destinationType)}`,
                    ],
                    newVariables: [],
                };
            }
            return {
                errors: [],
                newVariables: [{ name: ast.destination, type: destinationType, memoryCategory: 'FAKE' as any }],
            };
        }
        default:
            throw debug();
    }
};

const builtinTypes: { [index: string]: Type } = {
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
        memoryCategory: 'FAKE' as any,
    },
    {
        name: 'print',
        type: {
            name: 'Function',
            arguments: [builtinTypes.String, builtinTypes.Integer],
        },
        memoryCategory: 'FAKE' as any,
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
        memoryCategory: 'FAKE' as any,
    }));

const assignmentToDeclaration = (
    ast: Ast.UninferredAssignment,
    variablesInScope: VariableDeclaration[]
): VariableDeclaration => {
    const result = typeOfExpression(ast.expression, variablesInScope);
    if (isTypeError(result)) throw debug();
    return {
        name: ast.destination,
        type: result,
        memoryCategory: 'FAKE' as any,
    };
};

const inferOperators = (ast: Ast.UninferredAst, knownIdentifiers: VariableDeclaration[]): Ast.Ast => {
    const recurse = ast => inferOperators(ast, knownIdentifiers);
    switch (ast.kind) {
        case 'returnStatement':
            return { kind: 'returnStatement', expression: recurse(ast.expression) };
        case 'equality':
            return {
                kind: 'equality',
                lhs: recurse(ast.lhs),
                rhs: recurse(ast.rhs),
                type: typeOfExpression(ast.lhs, knownIdentifiers) as Type,
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
        case 'typedAssignment':
            return {
                kind: 'typedAssignment',
                expression: recurse(ast.expression),
                type: ast.type,
                destination: ast.destination,
            };
        case 'assignment':
            return {
                kind: 'typedAssignment',
                expression: recurse(ast.expression),
                type: typeOfExpression(ast.expression, knownIdentifiers) as Type,
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
            throw debug();
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
            throw debug();
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
                    memoryCategory: 'FAKE MemoryCategory' as any,
                },
            ];
        } else {
            throw debug();
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
        throw debug();
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
        default:
            throw debug();
    }
};

let functionId = 0;
const astFromParseResult = (ast: MplAst): Ast.UninferredAst => {
    if (!ast) debug();
    switch (ast.type) {
        case 'returnStatement':
            return {
                kind: 'returnStatement',
                expression: astFromParseResult(ast.children[1]),
            };
        case 'number':
            if (ast.value === undefined) throw debug();
            return {
                kind: 'number',
                value: ast.value as any,
            };
        case 'identifier':
            if (!ast.value) throw debug();
            return {
                kind: 'identifier',
                value: ast.value as any,
            };
        case 'product':
            if (!('children' in ast)) throw debug();
            return {
                kind: 'product',
                lhs: astFromParseResult(ast.children[0]),
                rhs: astFromParseResult(ast.children[2]),
            };
        case 'ternary':
            return {
                kind: 'ternary',
                condition: astFromParseResult(ast.children[0]),
                ifTrue: astFromParseResult(ast.children[2]),
                ifFalse: astFromParseResult(ast.children[4]),
            };
        case 'equality':
            if (!('children' in ast)) throw debug();
            return {
                kind: 'equality',
                lhs: astFromParseResult(ast.children[0]),
                rhs: astFromParseResult(ast.children[2]),
            };
        case 'paramList':
            throw debug(); //Should have been caught in "callExpression"
        case 'callExpressionNoArgs':
            return {
                kind: 'callExpression',
                name: (ast.children[0] as any).value as any,
                arguments: [],
            };
        case 'callExpression':
            return {
                kind: 'callExpression',
                name: (ast.children[0] as any).value as any,
                arguments: extractArgumentList(ast.children[2]).map(astFromParseResult),
            };
        case 'subtraction':
            if (!('children' in ast)) throw debug();
            return {
                kind: 'subtraction',
                lhs: astFromParseResult(ast.children[0]),
                rhs: astFromParseResult(ast.children[2]),
            };
        case 'addition':
            if (!('children' in ast)) throw debug();
            return {
                kind: 'addition',
                lhs: astFromParseResult(ast.children[0]),
                rhs: astFromParseResult(ast.children[2]),
            };
        case 'assignment':
            if (!('children' in ast)) throw debug();
            return {
                kind: 'assignment',
                destination: (ast.children[0] as any).value as any,
                expression: astFromParseResult(ast.children[2]),
            };
        case 'typedAssignment':
            if (!('children' in ast)) throw debug();
            return {
                kind: 'typedAssignment',
                destination: (ast.children[0] as any).value as any,
                type: parseType(ast.children[2]),
                expression: astFromParseResult(ast.children[4]),
            };
        case 'stringLiteral':
            return {
                kind: 'stringLiteral',
                value: ast.value as any,
            };
        case 'concatenation':
            if (!('children' in ast)) throw debug();
            return {
                kind: 'concatenation',
                lhs: astFromParseResult(ast.children[0]),
                rhs: astFromParseResult(ast.children[2]),
            };
        case 'equality':
            if (!('children' in ast)) throw debug();
            return {
                kind: 'equality',
                lhs: astFromParseResult(ast.children[0]),
                rhs: astFromParseResult(ast.children[2]),
            };
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
                    },
                ],
                parameters,
            };
        case 'functionWithBlock':
            functionId++;
            const parameters2: VariableDeclaration[] = extractParameterList(ast.children[0]);
            return {
                kind: 'functionLiteral',
                deanonymizedName: `anonymous_${functionId}`,
                body: extractFunctionBodyFromParseTree(ast.children[3]),
                parameters: parameters2,
            };
        case 'booleanLiteral':
            return {
                kind: 'booleanLiteral',
                value: ast.value == 'true',
            };
        case 'program':
            return {
                kind: 'program',
                statements: makeProgramAstNodeFromStatmentParseResult(ast.children[0]),
            };
        default:
            throw debug();
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
            throw debug();
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

    if (ast.kind !== 'program') {
        return { parseErrors: [{ kind: 'unexpectedProgram' }] };
    }
    const program: UninferredFunction = {
        name: `main_program`,
        statements: ast.statements,
        variables: [],
        parameters: [],
        temporaryCount: Math.max(...ast.statements.map(countTemporariesInExpression)),
    };

    const functions = extractFunctions(ast, builtinFunctions);
    const stringLiterals: StringLiteralData[] = uniqueBy(s => s.value, extractStringLiterals(ast));

    let variablesInScope = builtinFunctions;
    variablesInScope = mergeDeclarations(variablesInScope, getFunctionTypeMap(functions));
    const programTypeCheck = typeCheckFunction(program, variablesInScope);
    variablesInScope = mergeDeclarations(variablesInScope, programTypeCheck.identifiers);

    let typeErrors = functions.map(f => typeCheckFunction(f, variablesInScope).typeErrors);
    typeErrors.push(programTypeCheck.typeErrors);

    typeErrors = flatten(typeErrors);
    if (typeErrors.length > 0) {
        return { typeErrors };
    }

    const globalDeclarations: VariableDeclaration[] = program.statements
        .filter(s => s.kind === 'typedAssignment' || s.kind === 'assignment')
        .map(assignment => assignmentToDeclaration(assignment as any, variablesInScope));

    const typedProgramStatements = program.statements.map(s => inferOperators(s, variablesInScope));

    const typedFunctions: Function[] = [];
    functions.forEach(f => {
        typedFunctions.push({
            ...f,
            statements: f.statements.map(s =>
                inferOperators(s, mergeDeclarations(variablesInScope, f.variables))
            ) as Ast.Statement[],
        });
    });

    return {
        functions: typedFunctions,
        program: {
            ...program,
            statements: typedProgramStatements,
        } as Function,
        globalDeclarations,
        stringLiterals,
    };
};

export { parseMpl, lex, compile, removeBracketsFromAst, typeCheckStatement, parseErrorToString, astFromParseResult };
