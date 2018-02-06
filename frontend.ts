import flatten from './util/list/flatten.js';
import unique from './util/list/unique.js';
import sum from './util/list/sum.js';
import debug from './util/debug.js';
import { lex, Token } from './lex.js';
import { tokenSpecs, grammar, MplAstInteriorNode, MplAstNode, MplParseResult, MplToken } from './grammar.js';
import { ParseResult, parseResultIsError, parse, stripResultIndexes, AstLeaf } from './parser-combinator.js';
import {
    Type,
    VariableDeclaration,
    IdentifierDict,
    Function,
    MemoryCategory,
    BackendInputs,
    ParseError,
    TypeError,
} from './api.js';
import * as Ast from './ast.js';

type VariableDeclarationWithNoMemory = {
    name: string;
    type: Type;
};

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

const transformAst = (nodeType, f, ast: MplAstNode, recurseOnNew: boolean) => {
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

const transformUninferredAst = (
    nodeKind,
    f: ((n: Ast.UninferredAst) => Ast.UninferredAst),
    ast: Ast.UninferredAst,
    recurseOnNew: boolean
) => {
    if (!ast) debug();
    const recurse = (ast: Ast.UninferredAst) => transformUninferredAst(nodeKind, f, ast, recurseOnNew);
    if (ast.kind == nodeKind) {
        const newNode = f(ast);
        // If we aren't supposed to recurse, don't re-tranform the node we just made
        if (recurseOnNew) {
            return recurse(newNode);
        }
        ast = newNode;
    }
    switch (ast.kind) {
        case 'returnStatement':
            return {
                kind: ast.kind,
                expression: recurse(ast.expression),
            };
        case 'assignment':
            return {
                kind: ast.kind,
                destination: ast.destination,
                expression: recurse(ast.expression),
            };
        case 'typedAssignment':
            return {
                kind: ast.kind,
                destination: ast.destination,
                expression: recurse(ast.expression),
                type: ast.type,
            };
        case 'callExpression':
            return {
                kind: ast.kind,
                name: ast.name,
                argument: recurse(ast.argument),
            };
        case 'ternary':
            return {
                kind: ast.kind,
                condition: recurse(ast.condition),
                ifTrue: recurse(ast.ifTrue),
                ifFalse: recurse(ast.ifFalse),
            };
        // Operators all work with lhs/rhs
        case 'concatenation':
        case 'stringEquality':
        case 'equality':
        case 'addition':
        case 'subtraction':
        case 'product':
            return {
                kind: ast.kind,
                lhs: recurse(ast.lhs),
                rhs: recurse(ast.rhs),
            };
        // No children to recurse on in these node types
        case 'booleanLiteral':
        case 'stringLiteral':
        case 'functionLiteral':
        case 'identifier':
        case 'number':
            return ast;
        default:
            throw debug();
    }
};

const extractVariables = (
    statements: Ast.UninferredStatement[],
    knownIdentifiers: IdentifierDict
): VariableDeclaration[] => {
    const result: VariableDeclaration[] = [];
    statements.forEach(statement => {
        switch (statement.kind) {
            case 'assignment':
            case 'typedAssignment':
                result.push({
                    name: statement.destination,
                    memoryCategory: 'TODO: Fix memory category (extractVariables)' as any,
                    type: typeOfLoweredExpression(statement.expression, knownIdentifiers) as Type,
                });
                break;
            case 'returnStatement':
                break;
            default:
                throw debug();
        }
    });
    return result;
};

const extractFunctions = (ast: Ast.UninferredAst): Function[] => {
    switch (ast.kind) {
        case 'returnStatement':
        case 'typedAssignment':
        case 'assignment':
            return extractFunctions(ast.expression);
        case 'product':
        case 'addition':
        case 'subtraction':
        case 'equality':
        case 'stringEquality':
        case 'concatenation':
            return extractFunctions(ast.lhs).concat(extractFunctions(ast.rhs));
        case 'callExpression':
            return extractFunctions(ast.argument);
        case 'ternary':
            return extractFunctions(ast.condition)
                .concat(extractFunctions(ast.ifTrue))
                .concat(extractFunctions(ast.ifFalse));
        case 'program':
            return flatten(ast.statements.map(extractFunctions));
        case 'functionLiteral':
            functionId++;
            return flatten([
                [
                    {
                        name: ast.deanonymizedName,
                        statements: ast.body,
                        variables: extractVariables(ast.body, { [ast.argument.name]: ast.argument.type }),
                        argument: ast.argument,
                        temporaryCount: Math.max(...ast.body.map(countTemporariesInExpression)),
                        knownIdentifiers: {},
                    },
                ],
                ...ast.body.map(extractFunctions),
            ]);
        case 'number':
        case 'identifier':
        case 'stringLiteral':
            return [];
        default:
            throw debug();
    }
};

const extractStringLiterals = (ast: Ast.UninferredAst): string[] => {
    switch (ast.kind) {
        case 'returnStatement':
        case 'typedAssignment':
        case 'assignment':
            return extractStringLiterals(ast.expression);
        case 'product':
        case 'addition':
        case 'subtraction':
        case 'equality':
        case 'stringEquality':
        case 'concatenation':
            return extractStringLiterals(ast.lhs).concat(extractStringLiterals(ast.rhs));
        case 'callExpression':
            return extractStringLiterals(ast.argument);
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
            return [];
        case 'stringLiteral':
            return [ast.value];
        default:
            throw debug();
    }
};

const removeBracketsFromAst = ast => transformAst('bracketedExpression', node => node.children[1], ast, true);

const parseMpl = (tokens: Token<MplToken>[]): MplAstNode | ParseError[] => {
    const parseResult: MplParseResult = stripResultIndexes(parse(grammar, 'program', tokens, 0));

    if (parseResultIsError(parseResult)) {
        const errorMessage = `Expected ${parseResult.expected.join(' or ')}, found ${parseResult.found}`;
        return [errorMessage];
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
        case 'stringEquality':
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
            return 0;
        default:
            debug();
    }
};

const countTemporariesInFunction = ({ statements }) => {
    return Math.max(...statements.map(countTemporariesInExpression));
};

const typesAreEqual = (a, b) => {
    if (!a || !b) debug();
    if (a.name !== b.name) {
        return false;
    }
    return true;
};

const isTypeError = (val: Type | TypeError[]): val is TypeError[] => {
    return Array.isArray(val);
};

const combineErrors = (potentialErrors: (Type | TypeError[])[]): TypeError[] | null => {
    const result: TypeError[] = [];
    potentialErrors.forEach(e => {
        if (isTypeError(e)) {
            result.push(...e);
        }
    });
    return result.length > 0 ? result : null;
};

export const typeOfLoweredExpression = (
    ast: Ast.UninferredAst,
    knownIdentifiers: IdentifierDict
): Type | TypeError[] => {
    switch (ast.kind) {
        case 'number':
            return { name: 'Integer' };
        case 'addition':
        case 'product':
        case 'subtraction': {
            const leftType = typeOfLoweredExpression(ast.lhs, knownIdentifiers);
            const rightType = typeOfLoweredExpression(ast.rhs, knownIdentifiers);
            const combinedErrors = combineErrors([leftType, rightType]);
            if (combinedErrors) {
                return combinedErrors;
            }
            if (!typesAreEqual(leftType, { name: 'Integer' })) {
                return [`Left hand side of ${ast.kind} was not integer`];
            }
            if (!typesAreEqual(rightType, { name: 'Integer' })) {
                return [`Right hand side of ${ast.kind} was not integer`];
            }
            return { name: 'Integer' };
        }
        case 'stringEquality': {
            const leftType = typeOfLoweredExpression(ast.lhs, knownIdentifiers);
            const rightType = typeOfLoweredExpression(ast.rhs, knownIdentifiers);
            const combinedErrors = combineErrors([leftType, rightType]);
            if (combinedErrors) {
                return combinedErrors;
            }
            if (!typesAreEqual(leftType, rightType)) {
                return [
                    `Equality comparisons must compare values of the same type.. You tried to compare a ${
                        (leftType as Type).name
                    } (lhs) with a ${(rightType as Type).name} (rhs)`,
                ];
            }
            return { name: 'Boolean' };
        }
        case 'equality': {
            const leftType = typeOfLoweredExpression(ast.lhs, knownIdentifiers);
            const rightType = typeOfLoweredExpression(ast.rhs, knownIdentifiers);
            const combinedErrors = combineErrors([leftType, rightType]);
            if (combinedErrors) {
                return combinedErrors;
            }
            if (!typesAreEqual(leftType, rightType)) {
                return [
                    `Equality comparisons must compare values of the same type.. You tried to compare a ${
                        (leftType as Type).name
                    } (lhs) with a ${(rightType as Type).name} (rhs)`,
                ];
            }
            return { name: 'Boolean' };
        }
        case 'concatenation': {
            const leftType = typeOfLoweredExpression(ast.lhs, knownIdentifiers);
            const rightType = typeOfLoweredExpression(ast.rhs, knownIdentifiers);
            const combinedErrors = combineErrors([leftType, rightType]);
            if (combinedErrors) {
                return combinedErrors;
            }
            if ((leftType as Type).name !== 'String' || (rightType as Type).name !== 'String') {
                return ['Only strings can be concatenated right now'];
            }
            return { name: 'String' };
        }
        case 'functionLiteral': {
            return { name: 'Function', arg: { type: ast.argument.type } };
        }
        case 'callExpression': {
            const argType = typeOfLoweredExpression(ast.argument, knownIdentifiers);
            if (isTypeError(argType)) {
                return argType;
            }
            const functionName = ast.name;
            if (!(functionName in knownIdentifiers)) {
                return [`Unknown identifier: ${functionName}`];
            }
            const functionType = knownIdentifiers[functionName];
            if (!functionType) throw debug();
            if (functionType.name !== 'Function') {
                return [`You tried to call ${functionName}, but it's not a function (it's a ${functionType})`];
            }
            if (!argType || !functionType.arg) debug();
            if (!typesAreEqual(argType, functionType.arg.type)) {
                return [
                    `You passed a ${argType.name} as an argument to ${functionName}. It expects a ${
                        functionType.arg.type.name
                    }`,
                ];
            }
            return { name: 'Integer' };
        }
        case 'identifier': {
            if (ast.value in knownIdentifiers) {
                return knownIdentifiers[ast.value];
            } else {
                return [`Identifier ${ast.value} has unknown type.`];
            }
        }
        case 'ternary': {
            const conditionType = typeOfLoweredExpression(ast.condition, knownIdentifiers);
            const trueBranchType = typeOfLoweredExpression(ast.ifTrue, knownIdentifiers);
            const falseBranchType = typeOfLoweredExpression(ast.ifFalse, knownIdentifiers);
            const combinedErrors = combineErrors([conditionType, trueBranchType, falseBranchType]);
            if (combinedErrors) {
                return combinedErrors;
            }
            if (!typesAreEqual(conditionType, { name: 'Boolean' })) {
                return [
                    `You tried to use a ${
                        (conditionType as any).name
                    } as the condition in a ternary. Boolean is required`,
                ];
            }
            if (!typesAreEqual(trueBranchType, falseBranchType)) {
                return [
                    `Type mismatch in branches of ternary. True branch had ${
                        (trueBranchType as any).name
                    }, false branch had ${(falseBranchType as any).name}.`,
                ];
            }
            return trueBranchType;
        }
        case 'booleanLiteral':
            return { name: 'Boolean' };
        case 'stringLiteral':
            return { name: 'String' };
        default:
            throw debug();
    }
};

const typeCheckStatement = (
    ast: Ast.UninferredAst,
    knownIdentifiers
): { errors: string[]; newIdentifiers: IdentifierDict } => {
    if (!ast.kind) debug();
    switch (ast.kind) {
        case 'returnStatement': {
            const result = typeOfLoweredExpression(ast.expression, knownIdentifiers);
            if (isTypeError(result)) {
                return { errors: result, newIdentifiers: {} };
            }
            if (!typesAreEqual(result, { name: 'Integer' })) {
                return {
                    errors: [`You tried to return a ${result.name}`],
                    newIdentifiers: {},
                };
            }
            return { errors: [], newIdentifiers: {} };
        }
        case 'assignment': {
            const rightType = typeOfLoweredExpression(ast.expression, knownIdentifiers);
            if (isTypeError(rightType)) {
                return { errors: rightType, newIdentifiers: {} };
            }
            // Left type is inferred as right type
            return { errors: [], newIdentifiers: { [ast.destination]: rightType } };
        }
        case 'typedAssignment': {
            // Check that type of var being assigned to matches type being assigned
            const rightType = typeOfLoweredExpression(ast.expression, knownIdentifiers);
            if (!(ast as any).type) throw debug();
            const leftType = (ast as any).type;
            if (isTypeError(rightType)) {
                return { errors: rightType, newIdentifiers: {} };
            }
            if (!typesAreEqual(rightType, leftType)) {
                return {
                    errors: [
                        `You tried to assign a ${rightType.name} to "${ast.destination}", which has type ${
                            leftType.name
                        }`,
                    ],
                    newIdentifiers: {},
                };
            }
            return { errors: [], newIdentifiers: { [ast.destination]: leftType } };
        }
        default:
            throw debug();
    }
};

const builtinIdentifiers: IdentifierDict = {
    // TODO: Require these to be imported
    length: {
        name: 'Function',
        arg: { type: { name: 'String' } },
    },
};

const typeCheckProgram = (ast: Ast.UninferredProgram, previouslyKnownIdentifiers: IdentifierDict) => {
    let knownIdentifiers = { ...builtinIdentifiers, ...previouslyKnownIdentifiers };

    const allErrors: any = [];
    if (!ast.statements) debug();
    ast.statements.forEach(statement => {
        if (allErrors.length == 0) {
            const { errors, newIdentifiers } = typeCheckStatement(statement, knownIdentifiers);
            for (const identifier in newIdentifiers) {
                knownIdentifiers[identifier] = newIdentifiers[identifier];
            }
            allErrors.push(...errors);
        }
    });
    return { typeErrors: allErrors, identifiers: knownIdentifiers };
};

const typeCheckFunction = (f: Function, previouslyKnownIdentifiers: IdentifierDict) => {
    let knownIdentifiers = { ...builtinIdentifiers, ...previouslyKnownIdentifiers, [f.argument.name]: f.argument.type };

    const allErrors: any = [];
    f.statements.forEach(statement => {
        if (allErrors.length == 0) {
            const { errors, newIdentifiers } = typeCheckStatement(statement, knownIdentifiers);
            for (const identifier in newIdentifiers) {
                knownIdentifiers[identifier] = newIdentifiers[identifier];
            }
            allErrors.push(...errors);
        }
    });
    return { typeErrors: allErrors, identifiers: knownIdentifiers };
};

const getFunctionTypeMap = (functions: Function[]) => {
    const result = {};
    functions.forEach(({ name, argument }) => {
        result[name] = { name: 'Function', arg: { type: argument } };
    });
    return result;
};

const assignmentToDeclaration = (ast: Ast.UninferredAssignment, knownIdentifiers): VariableDeclarationWithNoMemory => {
    const result = typeOfLoweredExpression(ast.expression, knownIdentifiers);
    if (isTypeError(result)) throw debug();
    return {
        name: ast.destination,
        type: result,
    };
};

const inferOperators = (knownIdentifiers, statement: Ast.UninferredAst) => {
    const typedEquality = transformUninferredAst(
        'equality',
        (node: Ast.UninferredEquality): Ast.UninferredAst => {
            let leftType = typeOfLoweredExpression(node.lhs, knownIdentifiers);
            let rightType = typeOfLoweredExpression(node.rhs, knownIdentifiers);
            const combinedErrors = combineErrors([leftType, rightType]);
            if (combinedErrors) throw debug();
            if ((leftType as any).name === 'String' && (rightType as any).name === 'String') {
                return {
                    ...node,
                    kind: 'stringEquality',
                };
            } else {
                return node;
            }
        },
        statement,
        false
    );
    // TODO: Seems like this doesn't do anything
    const typedAssignment = transformUninferredAst(
        'assignment',
        (node: Ast.UninferredAssignment): Ast.UninferredAst => {
            return {
                kind: 'typedAssignment',
                destination: node.destination,
                type: typeOfLoweredExpression(node.expression, knownIdentifiers) as any,
                expression: node.expression,
            };
        },
        typedEquality,
        false
    );
    return typedAssignment;
};

type FrontendOutput = BackendInputs | { parseErrors: ParseError[] } | { typeErrors: TypeError[] };

const makeProgramAstNodeFromStatmentParseResult = (ast): Ast.UninferredStatement[] => {
    const children: Ast.UninferredStatement[] = [];
    if (ast.type === 'statement') {
        children.push(lowerAst(ast.children[0]) as Ast.UninferredStatement);
        children.push(...makeProgramAstNodeFromStatmentParseResult(ast.children[2]));
    } else {
        children.push(lowerAst(ast) as Ast.UninferredStatement);
    }
    return children;
};

const extractFunctionBodyFromParseTree = node => {
    switch (node.type) {
        case 'returnStatement':
            return [lowerAst(node)];
        case 'statement':
            return [lowerAst(node.children[0]), ...extractFunctionBodyFromParseTree(node.children[2])];
        default:
            throw debug();
    }
};

let functionId = 0;
const lowerAst = (ast: MplAstNode): Ast.UninferredAst => {
    if (!ast) debug();
    switch (ast.type) {
        case 'returnStatement':
            return {
                kind: 'returnStatement',
                expression: lowerAst(ast.children[1]),
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
                lhs: lowerAst(ast.children[0]),
                rhs: lowerAst(ast.children[2]),
            };
        case 'ternary':
            return {
                kind: 'ternary',
                condition: lowerAst(ast.children[0]),
                ifTrue: lowerAst(ast.children[2]),
                ifFalse: lowerAst(ast.children[4]),
            };
        case 'equality':
            if (!('children' in ast)) throw debug();
            return {
                kind: 'equality',
                lhs: lowerAst(ast.children[0]),
                rhs: lowerAst(ast.children[2]),
            };
        case 'callExpression':
            return {
                kind: 'callExpression',
                name: (ast.children[0] as any).value as any,
                argument: lowerAst(ast.children[2]),
            };
        case 'subtraction':
            if (!('children' in ast)) throw debug();
            return {
                kind: 'subtraction',
                lhs: lowerAst(ast.children[0]),
                rhs: lowerAst(ast.children[2]),
            };
        case 'addition':
            if (!('children' in ast)) throw debug();
            return {
                kind: 'addition',
                lhs: lowerAst(ast.children[0]),
                rhs: lowerAst(ast.children[2]),
            };
        case 'assignment':
            if (!('children' in ast)) throw debug();
            return {
                kind: 'assignment',
                destination: (ast.children[0] as any).value as any,
                expression: lowerAst(ast.children[2]),
            };
        case 'typedAssignment':
            if (!('children' in ast)) throw debug();
            return {
                kind: 'typedAssignment',
                destination: (ast.children[0] as any).value as any,
                type: { name: (ast.children[2] as any).value as any },
                expression: lowerAst(ast.children[4]),
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
                lhs: lowerAst(ast.children[0]),
                rhs: lowerAst(ast.children[2]),
            };
        case 'equality':
            if (!('children' in ast)) throw debug();
            return {
                kind: 'equality',
                lhs: lowerAst(ast.children[0]),
                rhs: lowerAst(ast.children[2]),
            };
        case 'function':
            functionId++;
            return {
                kind: 'functionLiteral',
                deanonymizedName: `anonymous_${functionId}`,
                body: [
                    {
                        kind: 'returnStatement',
                        expression: lowerAst(ast.children[2]),
                    },
                ],
                argument: {
                    name: ((ast.children[0] as MplAstInteriorNode).children[0] as AstLeaf<MplToken>).value as string,
                    type: {
                        name: ((ast.children[0] as MplAstInteriorNode).children[2] as AstLeaf<MplToken>).value as
                            | 'String'
                            | 'Integer'
                            | 'Boolean',
                    },
                    memoryCategory: 'FAKE MemoryCategory (functionWithBlock)' as any,
                },
            };
        case 'functionWithBlock':
            functionId++;
            return {
                kind: 'functionLiteral',
                deanonymizedName: `anonymous_${functionId}`,
                body: extractFunctionBodyFromParseTree(ast.children[3]),
                argument: {
                    name: ((ast.children[0] as MplAstInteriorNode).children[0] as AstLeaf<MplToken>).value as string,
                    type: {
                        name: ((ast.children[0] as MplAstInteriorNode).children[2] as AstLeaf<MplToken>).value as
                            | 'String'
                            | 'Integer'
                            | 'Boolean',
                    },
                    memoryCategory: 'FAKE MemoryCategory (functionWithBlock)' as any,
                },
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

const compile = (source: string): FrontendOutput => {
    const tokens = lex<MplToken>(tokenSpecs, source);
    const parseResult = parseMpl(tokens);

    if (Array.isArray(parseResult)) {
        return { parseErrors: parseResult };
    }

    const ast = lowerAst(parseResult);

    if (ast.kind !== 'program') {
        return { parseErrors: ['Failed to parse. Top Level of AST was not a program'] };
    }
    const program = {
        name: `main_program`,
        statements: ast.statements,
        variables: [],
        argument: undefined as any,
        temporaryCount: Math.max(...ast.statements.map(countTemporariesInExpression)),
        knownIdentifiers: {},
    };

    const functions = extractFunctions(ast);
    const stringLiterals = extractStringLiterals(ast);

    const functionIdentifierTypes = getFunctionTypeMap(functions);
    let knownIdentifiers = {
        ...builtinIdentifiers,
        ...functionIdentifierTypes,
    };

    const programTypeCheck = typeCheckProgram(ast, knownIdentifiers);

    knownIdentifiers = {
        ...knownIdentifiers,
        ...programTypeCheck.identifiers,
    };

    let typeErrors = functions.map(f => typeCheckFunction(f, knownIdentifiers).typeErrors);
    typeErrors.push(programTypeCheck.typeErrors);

    typeErrors = flatten(typeErrors);
    if (typeErrors.length > 0) {
        return { typeErrors };
    }

    const globalDeclarations: VariableDeclaration[] = program.statements
        .filter(s => s.kind === 'typedAssignment' || s.kind === 'assignment')
        .map(assignment => {
            const result = assignmentToDeclaration(assignment as any, {
                ...builtinIdentifiers,
                ...functionIdentifierTypes,
                ...programTypeCheck.identifiers,
            });
            if (!result.type) debug();
            return result;
        }) as any;

    return {
        functions,
        program,
        globalDeclarations,
        stringLiterals,
    } as BackendInputs;
};

export { parseMpl, lex, compile, removeBracketsFromAst };
