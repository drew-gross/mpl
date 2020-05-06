import flatten from './util/list/flatten';
import uniqueBy from './util/list/uniqueBy';
import idMaker from './util/idMaker';
import last from './util/list/last';
import debug from './util/debug';
import { lex, Token, LexError } from './parser-lib/lex';
import { tokenSpecs, grammar, MplAst, MplParseResult, MplToken } from './grammar';
import { parseResultIsError, parse, isSeparatedListNode, isListNode } from './parser-lib/parse';
import ParseError from './parser-lib/ParseError';
import {
    Type,
    ProductComponent,
    equal as typesAreEqual,
    resolveIfNecessary,
    resolveOrError,
    builtinTypes,
    builtinFunctions,
    TypeDeclaration,
    TypeReference,
} from './types';
import {
    VariableDeclaration,
    Function,
    UninferredFunction,
    FrontendOutput,
    StringLiteralData,
    ExportedVariable,
    GlobalVariable,
} from './api';
import { TypeError } from './TypeError';
import * as Ast from './ast';
/* tslint:disable */
const { add } = require('./mpl/add.mpl');
/* tslint:enable */

// TODO move this to parser lit
const hasType = (ast, type: string) => 'type' in ast && ast.type == type;

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
                        sourceLocation: ast.sourceLocation,
                    },
                    ast.children[1],
                    repairAssociativity(nodeType, ast.children[2].children[2]),
                ],
                sourceLocation: ast.sourceLocation,
            };
        } else {
            return {
                type: ast.type,
                children: ast.children.map(child => repairAssociativity(nodeType, child)),
                sourceLocation: ast.sourceLocation,
            };
        }
    } else if ('children' in ast) {
        return {
            type: ast.type,
            children: ast.children.map(child => repairAssociativity(nodeType, child)),
            sourceLocation: ast.sourceLocation,
        };
    } else {
        return ast;
    }
};

const transformAst = (nodeType, f, ast: MplAst, recurseOnNew: boolean): MplAst => {
    if (isSeparatedListNode(ast)) {
        return {
            items: ast.items.map(i => transformAst(nodeType, f, i, recurseOnNew)),
            separators: ast.separators.map(i => transformAst(nodeType, f, i, recurseOnNew)),
        };
    } else if (isListNode(ast)) {
        return { items: ast.items.map(i => transformAst(nodeType, f, i, recurseOnNew)) };
    } else if (ast.type === nodeType) {
        const newNode = f(ast);
        if ('children' in newNode) {
            // If we aren't supposed to recurse, don't re-tranform the node we just made
            if (recurseOnNew) {
                return transformAst(nodeType, f, newNode, recurseOnNew);
            } else {
                return {
                    type: newNode.type,
                    children: newNode.children.map(child =>
                        transformAst(nodeType, f, child, recurseOnNew)
                    ),
                    sourceLocation: ast.sourceLocation,
                };
            }
        } else {
            return newNode;
        }
    } else if ('children' in ast) {
        return {
            type: ast.type,
            children: ast.children.map(child => transformAst(nodeType, f, child, recurseOnNew)),
            sourceLocation: ast.sourceLocation,
        };
    } else {
        return ast;
    }
};

const extractVariable = (
    ctx: WithContext<Ast.UninferredStatement>
): VariableDeclaration | undefined => {
    switch (ctx.w.kind) {
        case 'reassignment':
        case 'declarationAssignment':
            // Recursive functions can refer to the left side on the right side, so to extract
            // the left side, we need to know about the right side. Probably, this just shouldn't return
            // a type. TODO: allow more types of recursive functions than just single int...
            return {
                name: ctx.w.destination,
                type: (typeOfExpression({ ...ctx, w: ctx.w.expression }) as TOEResult).type,
                exported: false,
            };
        case 'typedDeclarationAssignment':
            return {
                name: ctx.w.destination,
                type: (typeOfExpression(
                    { ...ctx, w: ctx.w.expression },
                    resolveIfNecessary(ctx.w.type, ctx.availableTypes)
                ) as TOEResult).type,
                exported: false,
            };
        case 'returnStatement':
        case 'typeDeclaration':
            return undefined;
        default:
            throw debug(`${(ctx.w as any).kind} unhandled in extractVariable`);
    }
};

const extractVariables = (
    ctx: WithContext<Ast.UninferredStatement[]>
): VariableDeclaration[] => {
    const variables: VariableDeclaration[] = [];
    ctx.w.forEach((statement: Ast.UninferredStatement) => {
        switch (statement.kind) {
            case 'returnStatement':
            case 'reassignment':
            case 'typeDeclaration':
                break;
            case 'declarationAssignment':
            case 'typedDeclarationAssignment':
                const potentialVariable = extractVariable({
                    w: statement,
                    availableVariables: mergeDeclarations(ctx.availableVariables, variables),
                    availableTypes: ctx.availableTypes,
                });
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
    ctx: WithContext<Ast.UninferredFunctionLiteral>
): UninferredFunction => ({
    name: ctx.w.deanonymizedName,
    statements: ctx.w.body,
    variables: [
        ...ctx.w.parameters,
        ...extractVariables({
            w: ctx.w.body,
            availableVariables: mergeDeclarations(ctx.availableVariables, ctx.w.parameters),
            availableTypes: ctx.availableTypes,
        }),
    ],
    parameters: ctx.w.parameters,
});

const walkAst = <ReturnType, NodeType extends Ast.UninferredAst>(
    ast: Ast.UninferredAst,
    nodeKinds: string[],
    extractItem: (item: NodeType) => ReturnType
): ReturnType[] => {
    const recurse = ast2 => walkAst(ast2, nodeKinds, extractItem);
    let result: ReturnType[] = [];
    if (nodeKinds.includes(ast.kind)) {
        result = [extractItem(ast as NodeType)];
    }
    switch (ast.kind) {
        case 'returnStatement':
        case 'typedDeclarationAssignment':
        case 'declarationAssignment':
        case 'reassignment':
            return [...result, ...recurse(ast.expression)];
        case 'product':
        case 'addition':
        case 'subtraction':
        case 'equality':
        case 'concatenation':
            return [...result, ...recurse(ast.lhs), ...recurse(ast.rhs)];
        case 'callExpression':
            return [...result, ...flatten(ast.arguments.map(recurse))];
        case 'ternary':
            return [
                ...result,
                ...recurse(ast.condition)
                    .concat(recurse(ast.ifTrue))
                    .concat(recurse(ast.ifFalse)),
            ];
        case 'program':
            return [...result, ...flatten(ast.statements.map(recurse))];
        case 'functionLiteral':
            return [...result, ...flatten(ast.body.map(recurse))];
        case 'objectLiteral':
            return [
                ...result,
                ...flatten(ast.members.map(member => recurse(member.expression))),
            ];
        case 'memberAccess':
            return [...result, ...recurse(ast.lhs)];
        case 'number':
        case 'identifier':
        case 'stringLiteral':
        case 'booleanLiteral':
        case 'typeDeclaration':
            return result;
        case 'listLiteral':
            return [...result, ...flatten(ast.items.map(recurse))];
        case 'indexAccess':
            return [...result, ...recurse(ast.accessed), ...recurse(ast.index)];
        case 'memberStyleCall':
            return [...result, ...recurse(ast.lhs), ...flatten(ast.params.map(recurse))];
        default:
            throw debug(`${(ast as any).kind} unhandled in walkAst`);
    }
};

const removeBracketsFromAst = ast =>
    transformAst('bracketedExpression', node => node.children[1], ast, true);

const parseMpl = (tokens: Token<MplToken>[]): MplAst | ParseError[] => {
    const parseResult: MplParseResult = parse(grammar, 'program', tokens);

    if (parseResultIsError(parseResult)) {
        // TODO: Just get the parser to give us good errors directly instead of taking the first
        return [parseResult.errors[0]];
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

const isTypeError = <T>(val: T | TypeError[]): val is TypeError[] => Array.isArray(val);

const combineErrors = <Success>(
    potentialErrors: (Success | TypeError[])[]
): TypeError[] | null => {
    const result: TypeError[] = [];
    potentialErrors.forEach(e => {
        if (isTypeError(e)) {
            result.push(...e);
        }
    });
    return result.length > 0 ? result : null;
};

type TOEResult = { type: Type; extractedFunctions: Function[] };

// TODO: It's kinda weird that this accepts an Uninferred AST. This function should maybe be merged with infer() maybe?
export const typeOfExpression = (
    ctx: WithContext<Ast.UninferredExpression>,
    expectedType: Type | undefined = undefined
): TOEResult | TypeError[] => {
    const recurse = ast2 => typeOfExpression({ ...ctx, w: ast2 });
    const { w, availableVariables, availableTypes } = ctx;
    const ast = w;
    switch (ast.kind) {
        case 'number':
            return { type: builtinTypes.Integer, extractedFunctions: [] };
        case 'addition':
        case 'product':
        case 'subtraction': {
            const leftType = recurse(ast.lhs);
            const rightType = recurse(ast.rhs);
            const combinedErrors = combineErrors([leftType, rightType]);
            if (combinedErrors) {
                return combinedErrors;
            }
            const lt = leftType as TOEResult;
            const rt = rightType as TOEResult;
            if (!typesAreEqual(lt.type, builtinTypes.Integer)) {
                return [
                    {
                        kind: 'wrongTypeForOperator',
                        operator: ast.kind,
                        expected: 'Integer',
                        found: lt.type,
                        side: 'left',
                        sourceLocation: ast.sourceLocation,
                    },
                ];
            }
            if (!typesAreEqual(rt.type, builtinTypes.Integer)) {
                return [
                    {
                        kind: 'wrongTypeForOperator',
                        operator: ast.kind,
                        expected: 'Integer',
                        found: rt.type,
                        side: 'right',
                        sourceLocation: ast.sourceLocation,
                    },
                ];
            }
            return {
                type: builtinTypes.Integer,
                extractedFunctions: [...lt.extractedFunctions, ...rt.extractedFunctions],
            };
        }
        case 'equality': {
            const leftType = recurse(ast.lhs);
            const rightType = recurse(ast.rhs);
            const combinedErrors = combineErrors([leftType, rightType]);
            if (combinedErrors) {
                return combinedErrors;
            }
            const lt = leftType as TOEResult;
            const rt = rightType as TOEResult;
            if (!typesAreEqual(lt.type, rt.type)) {
                return [
                    {
                        kind: 'typeMismatchForOperator',
                        leftType: lt.type,
                        rightType: rt.type,
                        operator: 'equality',
                        sourceLocation: ast.sourceLocation,
                    },
                ];
            }
            return { type: builtinTypes.Boolean, extractedFunctions: [] };
        }
        case 'concatenation': {
            const leftType = recurse(ast.lhs);
            const rightType = recurse(ast.rhs);
            const combinedErrors = combineErrors([leftType, rightType]);
            if (combinedErrors) {
                return combinedErrors;
            }
            const lt = leftType as TOEResult;
            const rt = rightType as TOEResult;
            if (lt.type.type.kind !== 'String') {
                return [
                    {
                        kind: 'wrongTypeForOperator',
                        found: lt.type,
                        expected: 'String',
                        operator: 'concatenation',
                        side: 'left',
                        sourceLocation: ast.sourceLocation,
                    },
                ];
            }
            if (rt.type.type.kind !== 'String') {
                return [
                    {
                        kind: 'wrongTypeForOperator',
                        found: rt.type,
                        expected: 'String',
                        operator: 'concatenation',
                        side: 'right',
                        sourceLocation: ast.sourceLocation,
                    },
                ];
            }
            return {
                type: builtinTypes.String,
                extractedFunctions: [...lt.extractedFunctions, ...rt.extractedFunctions],
            };
        }
        case 'functionLiteral':
            const functionObject = functionObjectFromAst({ ...ctx, w: ast });
            const f = inferFunction({
                w: functionObject,
                availableVariables: mergeDeclarations(
                    ctx.availableVariables,
                    functionObject.variables
                ),
                availableTypes: ctx.availableTypes,
            });
            if (isTypeError(f)) {
                return f;
            }
            return {
                type: {
                    type: {
                        kind: 'Function',
                        arguments: ast.parameters
                            .map(p => p.type)
                            .map(t => {
                                const resolved = resolveIfNecessary(t, ctx.availableTypes);
                                if (!resolved) {
                                    throw debug('bag argument. This should be a better error.');
                                }
                                return resolved;
                            }),
                        permissions: [],
                        returnType: f.returnType,
                    },
                },
                extractedFunctions: [f], // TODO: Add functions extracted within the function itself
            };
        case 'callExpression': {
            const argTypes: (TOEResult | TypeError[])[] = ast.arguments.map(argument =>
                recurse(argument)
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
            const declaration = availableVariables.find(({ name }) => functionName == name);
            if (!declaration) {
                return [
                    {
                        kind: 'unknownIdentifier',
                        name: functionName,
                        sourceLocation: ast.sourceLocation,
                    },
                ];
            }
            const functionType = declaration.type;
            if (!functionType) throw debug('bad function! This should be a better error.');
            if ('namedType' in functionType) {
                throw debug('nameRef function! This should be supported.');
            }
            if (functionType.type.kind !== 'Function') {
                return [
                    {
                        kind: 'calledNonFunction',
                        identifierName: functionName,
                        actualType: functionType,
                        sourceLocation: ast.sourceLocation,
                    },
                ];
            }
            if (argTypes.length !== functionType.type.arguments.length) {
                return [
                    {
                        kind: 'wrongNumberOfArguments',
                        targetFunction: functionName,
                        passedArgumentCount: argTypes.length,
                        expectedArgumentCount: functionType.type.arguments.length,
                        sourceLocation: ast.sourceLocation,
                    },
                ];
            }
            for (let i = 0; i < argTypes.length; i++) {
                const resolved = resolveOrError(
                    functionType.type.arguments[i],
                    ctx.availableTypes,
                    ast.sourceLocation
                );
                if ('errors' in resolved) {
                    return resolved.errors;
                }
                if (!typesAreEqual((argTypes[i] as TOEResult).type, resolved)) {
                    return [
                        {
                            kind: 'wrongArgumentType',
                            targetFunction: functionName,
                            passedType: (argTypes[i] as TOEResult).type,
                            expectedType: functionType.type.arguments[i],
                            sourceLocation: ast.sourceLocation,
                        } as TypeError,
                    ];
                }
            }
            const returnType = resolveOrError(
                functionType.type.returnType,
                ctx.availableTypes,
                ast.sourceLocation
            );
            if ('errors' in returnType) {
                return returnType.errors;
            }
            return { type: returnType, extractedFunctions: [] };
        }
        case 'memberStyleCall': {
            const callArgTypes: (TOEResult | TypeError[])[] = ast.params.map(recurse);

            const argTypeErrors: TypeError[] = [];
            callArgTypes.forEach(argType => {
                if (isTypeError(argType)) {
                    argTypeErrors.push(...argType);
                }
            });

            if (argTypeErrors.length > 0) {
                return argTypeErrors;
            }

            const thisArgType = recurse(ast.lhs);
            if (isTypeError(thisArgType)) {
                return thisArgType;
            }

            const functionName = ast.memberName;
            const declaration = availableVariables.find(({ name }) => functionName == name);
            if (!declaration) {
                return [
                    {
                        kind: 'unknownIdentifier',
                        name: functionName,
                        sourceLocation: ast.sourceLocation,
                    },
                ];
            }
            const functionType = declaration.type;
            if (!functionType) throw debug('bad function! This should be a better error.');
            if ('namedType' in functionType) {
                throw debug('nameRef function! This should be supported.');
            }
            if (functionType.type.kind !== 'Function') {
                return [
                    {
                        kind: 'calledNonFunction',
                        identifierName: functionName,
                        actualType: functionType,
                        sourceLocation: ast.sourceLocation,
                    },
                ];
            }
            const allArgTypes = [thisArgType, ...callArgTypes];
            if (allArgTypes.length !== functionType.type.arguments.length) {
                return [
                    {
                        kind: 'wrongNumberOfArguments',
                        targetFunction: functionName,
                        passedArgumentCount: allArgTypes.length,
                        expectedArgumentCount: functionType.type.arguments.length,
                        sourceLocation: ast.sourceLocation,
                    },
                ];
            }
            // TODO: this is probably wrong, we need check agains the LHS type
            for (let i = 0; i < allArgTypes.length; i++) {
                const resolved = resolveOrError(
                    functionType.type.arguments[i],
                    ctx.availableTypes,
                    ast.sourceLocation
                );
                if ('errors' in resolved) {
                    return resolved.errors;
                }
                if (!typesAreEqual((allArgTypes[i] as TOEResult).type, resolved)) {
                    return [
                        {
                            kind: 'wrongArgumentType',
                            targetFunction: functionName,
                            passedType: (allArgTypes[i] as TOEResult).type,
                            expectedType: functionType.type.arguments[i],
                            sourceLocation: ast.sourceLocation,
                        } as TypeError,
                    ];
                }
            }
            const returnType = resolveOrError(
                functionType.type.returnType,
                ctx.availableTypes,
                ast.sourceLocation
            );
            if ('errors' in returnType) {
                return returnType.errors;
            }
            return { type: returnType, extractedFunctions: [] };
        }
        case 'identifier': {
            const unresolved = availableVariables.find(({ name }) => ast.value == name);
            if (!unresolved) {
                return [
                    {
                        kind: 'unknownTypeForIdentifier',
                        identifierName: ast.value,
                        sourceLocation: ast.sourceLocation,
                    },
                ];
            }
            const declaration = resolveIfNecessary(unresolved.type, availableTypes);
            if (!declaration) {
                return [
                    {
                        kind: 'couldNotFindType',
                        name: (unresolved.type as any).namedType,
                        sourceLocation: ast.sourceLocation,
                    },
                ];
            }
            return { type: declaration, extractedFunctions: [] };
        }
        case 'ternary': {
            const conditionType = recurse(ast.condition);
            const trueBranchType = recurse(ast.ifTrue);
            const falseBranchType = recurse(ast.ifFalse);
            const combinedErrors = combineErrors([
                conditionType,
                trueBranchType,
                falseBranchType,
            ]);
            if (
                combinedErrors ||
                isTypeError(trueBranchType) ||
                isTypeError(falseBranchType) ||
                isTypeError(conditionType)
            ) {
                if (combinedErrors) {
                    return combinedErrors;
                } else {
                    return [];
                }
            }
            if (!typesAreEqual(conditionType.type, builtinTypes.Boolean)) {
                return [
                    {
                        kind: 'wrongTypeForOperator',
                        found: conditionType.type,
                        expected: 'Boolean',
                        operator: 'Ternary',
                        side: 'left',
                        sourceLocation: ast.sourceLocation,
                    },
                ];
            }
            if (!typesAreEqual(trueBranchType.type, falseBranchType.type)) {
                return [
                    {
                        kind: 'ternaryBranchMismatch',
                        trueBranchType: trueBranchType.type,
                        falseBranchType: falseBranchType.type,
                        sourceLocation: ast.sourceLocation,
                    } as TypeError,
                ];
            }
            return trueBranchType;
        }
        case 'booleanLiteral':
            return { type: builtinTypes.Boolean, extractedFunctions: [] };
        case 'stringLiteral':
            return { type: builtinTypes.String, extractedFunctions: [] };
        case 'objectLiteral':
            const memberTypes = ast.members.map(({ expression }) => recurse(expression));
            const typeErrors: TypeError[] = flatten(memberTypes.filter(isTypeError));
            if (!(typeErrors.length == 0)) return typeErrors;
            return {
                type: {
                    type: {
                        kind: 'Product',
                        name: ast.typeName,
                        members: ast.members.map(({ name, expression }) => ({
                            name,
                            type: (recurse(expression) as TOEResult).type,
                        })),
                    },
                    original: { namedType: ast.typeName },
                },
                extractedFunctions: [], // TODO: propagate these
            };
        case 'memberAccess':
            const lhsType = recurse(ast.lhs);
            if (isTypeError(lhsType)) {
                return lhsType;
            }
            const resolvedLhs = lhsType.type;
            if (resolvedLhs.type.kind != 'Product') {
                return [
                    {
                        kind: 'invalidMemberAccess',
                        found: lhsType.type,
                        sourceLocation: ast.sourceLocation,
                    },
                ];
            }
            const accessedMember = resolvedLhs.type.members.find(m => m.name == ast.rhs);
            if (!accessedMember) {
                return [
                    {
                        kind: 'objectDoesNotHaveMember',
                        lhsType: lhsType.type,
                        member: ast.rhs,
                        sourceLocation: ast.sourceLocation,
                    },
                ];
            }
            return { type: accessedMember.type, extractedFunctions: [] };
        case 'listLiteral':
            let innerType: Type | undefined;
            const extractedFunctions: Function[] = [];
            for (const item of ast.items) {
                const result = recurse(item);
                if (isTypeError(result)) {
                    return result;
                }
                if (!innerType) {
                    innerType = result.type;
                } else if (!typesAreEqual(innerType, result.type)) {
                    return [{ kind: 'nonhomogenousList', sourceLocation: ast.sourceLocation }];
                }
                extractedFunctions.push(...result.extractedFunctions);
            }
            if (!innerType) {
                if (expectedType) {
                    return { type: expectedType, extractedFunctions };
                }
                return [{ kind: 'uninferrableEmptyList', sourceLocation: ast.sourceLocation }];
            }
            return { type: { type: { kind: 'List', of: innerType } }, extractedFunctions };
        case 'indexAccess':
            const accessedType = recurse(ast.accessed);
            if (isTypeError(accessedType)) {
                return accessedType;
            }
            if (accessedType.type.type.kind != 'List') {
                return [
                    {
                        kind: 'indexAccessNonList',
                        accessed: accessedType.type,
                        sourceLocation: ast.sourceLocation,
                    },
                ];
            }
            const indexType = recurse(ast.index);
            if (isTypeError(indexType)) {
                return indexType;
            }
            if (indexType.type.type.kind != 'Integer') {
                return [
                    {
                        kind: 'nonIntegerIndex',
                        index: indexType.type,
                        sourceLocation: ast.sourceLocation,
                    },
                ];
            }
            return {
                type: accessedType.type.type.of,
                extractedFunctions: [
                    ...accessedType.extractedFunctions,
                    ...indexType.extractedFunctions,
                ],
            };
        default:
            throw debug(`${(ast as any).kind} unhandled in typeOfExpression`);
    }
};

const typeCheckStatement = (
    ctx: WithContext<Ast.UninferredStatement>
): { errors: TypeError[]; newVariables: VariableDeclaration[] } => {
    const { w, availableTypes, availableVariables } = ctx;
    const ast = w;
    if (!ast.kind) debug('!ast.kind');
    switch (ast.kind) {
        case 'returnStatement': {
            const result = typeOfExpression({ ...ctx, w: ast.expression });
            if (isTypeError(result)) {
                return { errors: result, newVariables: [] };
            }
            return { errors: [], newVariables: [] };
        }
        case 'declarationAssignment': {
            const rightType = typeOfExpression({
                w: ast.expression,
                availableTypes,
                availableVariables: mergeDeclarations(availableVariables, [
                    {
                        name: ast.destination,
                        type: {
                            type: {
                                kind: 'Function' as 'Function',
                                arguments: [{ type: { kind: 'Integer' } }],
                                permissions: [],
                                returnType: { type: { kind: 'Integer' } },
                            },
                        },
                        exported: false,
                    },
                ]),
            });
            if (isTypeError(rightType)) {
                return { errors: rightType, newVariables: [] };
            }
            // Left type is inferred as right type
            return {
                errors: [],
                newVariables: [{ name: ast.destination, type: rightType.type, exported: false }],
            };
        }
        case 'reassignment': {
            const rightType = typeOfExpression({ ...ctx, w: ast.expression });
            if (isTypeError(rightType)) {
                return { errors: rightType, newVariables: [] };
            }
            const unresolvedLeftType = availableVariables.find(v => v.name == ast.destination);
            if (!unresolvedLeftType) {
                return {
                    errors: [
                        {
                            kind: 'assignUndeclaredIdentifer',
                            destinationName: ast.destination,
                            sourceLocation: ast.sourceLocation,
                        },
                    ],
                    newVariables: [],
                };
            }
            const leftType = resolveIfNecessary(unresolvedLeftType.type, availableTypes);
            if (!leftType) {
                return {
                    errors: [
                        {
                            kind: 'couldNotFindType',
                            name: unresolvedLeftType.name,
                            sourceLocation: ast.sourceLocation,
                        },
                    ],
                    newVariables: [],
                };
            }

            if (!typesAreEqual(leftType, rightType.type)) {
                return {
                    errors: [
                        {
                            kind: 'assignWrongType',
                            lhsName: ast.destination,
                            lhsType: leftType,
                            rhsType: rightType.type,
                            sourceLocation: ast.sourceLocation,
                        },
                    ],
                    newVariables: [],
                };
            }
            return { errors: [], newVariables: [] };
        }
        case 'typedDeclarationAssignment': {
            // Check that type of var being assigned to matches type being assigned
            const destinationType = ast.type;
            const resolvedDestination = resolveOrError(
                destinationType,
                availableTypes,
                ast.sourceLocation
            );
            if ('errors' in resolvedDestination) {
                return resolvedDestination;
            }
            const expressionType = typeOfExpression(
                {
                    ...ctx,
                    w: ast.expression,
                    availableVariables: mergeDeclarations(availableVariables, [
                        { name: ast.destination, type: destinationType, exported: false },
                    ]),
                },
                resolvedDestination
            );
            if (isTypeError(expressionType)) {
                return { errors: expressionType, newVariables: [] };
            }
            if (!typesAreEqual(expressionType.type, resolvedDestination)) {
                return {
                    errors: [
                        {
                            kind: 'assignWrongType',
                            lhsName: ast.destination,
                            lhsType: resolvedDestination,
                            rhsType: expressionType.type,
                            sourceLocation: ast.sourceLocation,
                        },
                    ],
                    newVariables: [],
                };
            }
            return {
                errors: [],
                newVariables: [
                    { name: ast.destination, type: destinationType, exported: false },
                ],
            };
        }
        case 'typeDeclaration':
            return {
                errors: [],
                newVariables: [],
            };
        default:
            throw debug(`${(ast as any).kind} unhandled in typeCheckStatement`);
    }
};

const mergeDeclarations = (
    left: VariableDeclaration[],
    right: VariableDeclaration[]
): VariableDeclaration[] => {
    const result = [...right];
    left.forEach(declaration => {
        if (!result.some(({ name }) => name == declaration.name)) {
            result.unshift(declaration);
        }
    });
    return result;
};

const typeCheckFunction = (ctx: WithContext<UninferredFunction>) => {
    let availableVariables = mergeDeclarations(ctx.availableVariables, ctx.w.parameters);
    const allErrors: any = [];
    ctx.w.statements.forEach(statement => {
        if (allErrors.length == 0) {
            const { errors, newVariables } = typeCheckStatement({
                ...ctx,
                w: statement,
                availableVariables,
            });
            availableVariables = mergeDeclarations(availableVariables, newVariables);
            allErrors.push(...errors);
        }
    });
    return { typeErrors: allErrors, identifiers: availableVariables };
};

const assignmentToGlobalDeclaration = (
    ctx: WithContext<Ast.UninferredDeclarationAssignment>
): GlobalVariable => {
    const result = typeOfExpression({ ...ctx, w: ctx.w.expression });
    if (isTypeError(result)) throw debug('isTypeError in assignmentToGlobalDeclaration');
    return {
        name: ctx.w.destination,
        type: result.type,
        exported: ctx.w.exported,
        mangledName:
            ctx.w.expression.kind == 'functionLiteral'
                ? ctx.w.expression.deanonymizedName
                : ctx.w.destination,
    };
};

type WithContext<T> = {
    w: T;
    availableTypes: TypeDeclaration[];
    availableVariables: VariableDeclaration[];
};

const inferFunction = (ctx: WithContext<UninferredFunction>): Function | TypeError[] => {
    const variablesFound = mergeDeclarations(ctx.availableVariables, ctx.w.parameters);
    const statements: Ast.Statement[] = [];
    ctx.w.statements.forEach(statement => {
        const statementContext: WithContext<Ast.UninferredStatement> = {
            w: statement,
            availableVariables: variablesFound,
            availableTypes: ctx.availableTypes,
        };
        const maybeNewVariable = extractVariable(statementContext);
        if (maybeNewVariable) {
            variablesFound.push(maybeNewVariable);
        }
        statements.push(infer(statementContext) as Ast.Statement);
    });
    const maybeReturnStatement = last(ctx.w.statements);
    if (!maybeReturnStatement) {
        return [{ kind: 'missingReturn', sourceLocation: { line: 0, column: 0 } }];
    }
    if (maybeReturnStatement.kind != 'returnStatement') {
        return [{ kind: 'missingReturn', sourceLocation: maybeReturnStatement.sourceLocation }];
    }
    const returnStatement = maybeReturnStatement;
    const returnType = typeOfExpression({
        ...ctx,
        availableVariables: variablesFound,
        w: returnStatement.expression,
    });
    if (isTypeError(returnType)) {
        return returnType;
    }
    return {
        name: ctx.w.name,
        statements,
        variables: ctx.w.variables,
        parameters: ctx.w.parameters,
        returnType: returnType.type,
    };
};

// TODO: merge this with typecheck maybe?
const infer = (ctx: WithContext<Ast.UninferredAst>): Ast.Ast => {
    const recurse = ast2 => infer({ ...ctx, w: ast2 });
    const { w, availableVariables, availableTypes } = ctx;
    const ast = w;
    switch (ast.kind) {
        case 'returnStatement':
            return {
                kind: 'returnStatement',
                expression: recurse(ast.expression),
                sourceLocation: ast.sourceLocation,
            };
        case 'equality':
            const equalityType = typeOfExpression({ ...ctx, w: ast.lhs });
            if (isTypeError(equalityType)) throw debug('couldNotFindType');

            return {
                kind: 'equality',
                sourceLocation: ast.sourceLocation,
                lhs: recurse(ast.lhs),
                rhs: recurse(ast.rhs),
                type: equalityType.type,
            };
        case 'product':
            return {
                kind: ast.kind,
                sourceLocation: ast.sourceLocation,
                lhs: recurse(ast.lhs),
                rhs: recurse(ast.rhs),
            };
        case 'addition':
            return {
                kind: ast.kind,
                sourceLocation: ast.sourceLocation,
                lhs: recurse(ast.lhs),
                rhs: recurse(ast.rhs),
            };
        case 'subtraction':
            return {
                kind: ast.kind,
                sourceLocation: ast.sourceLocation,
                lhs: recurse(ast.lhs),
                rhs: recurse(ast.rhs),
            };
        case 'concatenation':
            return {
                kind: ast.kind,
                sourceLocation: ast.sourceLocation,
                lhs: recurse(ast.lhs),
                rhs: recurse(ast.rhs),
            };
        case 'typedDeclarationAssignment':
            const resolved = resolveIfNecessary(ast.type, availableTypes);
            if (!resolved) throw debug("resolution shouldn't fail here");
            return {
                kind: 'typedDeclarationAssignment',
                sourceLocation: ast.sourceLocation,
                expression: recurse(ast.expression),
                type: resolved,
                destination: ast.destination,
            };
        case 'declarationAssignment':
            const type = typeOfExpression({ ...ctx, w: ast.expression });
            if (isTypeError(type)) throw debug("type error when there shouldn't be");
            return {
                kind: 'typedDeclarationAssignment',
                sourceLocation: ast.sourceLocation,
                expression: recurse(ast.expression),
                type: type.type,
                destination: ast.destination,
            };
        case 'reassignment':
            return {
                kind: 'reassignment',
                sourceLocation: ast.sourceLocation,
                expression: recurse(ast.expression),
                destination: ast.destination,
            };
        case 'callExpression':
            return {
                kind: 'callExpression',
                sourceLocation: ast.sourceLocation,
                name: ast.name,
                arguments: ast.arguments.map(recurse),
            };
        case 'memberStyleCall':
            return {
                kind: 'callExpression',
                sourceLocation: ast.sourceLocation,
                name: ast.memberName,
                arguments: [recurse(ast.lhs), ...ast.params.map(recurse)],
            };
        case 'ternary':
            return {
                kind: 'ternary',
                sourceLocation: ast.sourceLocation,
                condition: recurse(ast.condition),
                ifTrue: recurse(ast.ifTrue),
                ifFalse: recurse(ast.ifFalse),
            };
        case 'functionLiteral':
            return {
                kind: 'functionLiteral',
                sourceLocation: ast.sourceLocation,
                deanonymizedName: ast.deanonymizedName,
            };
        case 'typeDeclaration':
            // TODO: maybe just strip declarations before inferring.
            return { kind: 'typeDeclaration', sourceLocation: ast.sourceLocation };
        case 'objectLiteral':
            const declaredType = availableTypes.find(t => t.name == ast.typeName);
            if (!declaredType) {
                throw debug(`type ${ast.typeName} not found`);
            }
            return {
                kind: 'objectLiteral',
                sourceLocation: ast.sourceLocation,
                type: declaredType.type,
                members: ast.members.map(({ name, expression }) => ({
                    name,
                    expression: recurse(expression),
                })),
            };
        case 'memberAccess':
            const accessedObject = recurse(ast.lhs);
            const accessedType = typeOfExpression({
                w: ast.lhs,
                availableVariables,
                availableTypes,
            });
            if (isTypeError(accessedType)) {
                throw debug("shouldn't be a type error here");
            }
            return {
                kind: 'memberAccess',
                sourceLocation: ast.sourceLocation,
                lhs: accessedObject,
                rhs: ast.rhs,
                lhsType: accessedType.type,
            };
        case 'listLiteral':
            let itemType: Type | undefined = undefined;
            const items: Ast.Ast[] = [];
            for (const item of ast.items) {
                const newItem = recurse(item);
                items.push(newItem);
                if (itemType === undefined) {
                    const maybeItemType = typeOfExpression({
                        w: item,
                        availableVariables,
                        availableTypes,
                    });
                    if (isTypeError(maybeItemType)) {
                        throw debug("shouldn't be type error here");
                    }
                    itemType = maybeItemType.type;
                }
            }
            if (!itemType) throw debug('no itemType');
            return {
                kind: 'listLiteral',
                sourceLocation: ast.sourceLocation,
                type: { type: { kind: 'List', of: itemType } },
                items,
            };
        case 'indexAccess':
            return {
                kind: 'indexAccess',
                sourceLocation: ast.sourceLocation,
                accessed: recurse(ast.accessed),
                index: recurse(ast.index),
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

const extractFunctionBody = node => {
    if (node.type !== 'statement') debug('expected a statement');
    if (node.children.length === 3) {
        return [astFromParseResult(node.children[0]), ...extractFunctionBody(node.children[2])];
    } else {
        return [astFromParseResult(node.children[0])];
    }
};

// TODO: Replace extractParameterList with SeparatedList
const extractParameterList = (ast: MplAst): VariableDeclaration[] => {
    if (isSeparatedListNode(ast)) {
        return flatten(
            ast.items.map(i => {
                if (isSeparatedListNode(i) || !('children' in i)) {
                    throw debug('todo');
                }
                const child2 = i.children[2];
                if (isSeparatedListNode(child2) || isListNode(child2)) {
                    throw debug('todo');
                }
                if (child2.type == 'typeWithoutArgs') {
                    return [
                        {
                            name: (i.children[0] as any).value as string,
                            type: parseType(child2),
                            exported: false,
                        },
                    ];
                } else {
                    throw debug('wrong children length');
                }
            })
        );
    } else {
        throw debug(`${(ast as any).type} unhandledi extractParameterList`);
    }
};

const parseTypeLiteralComponent = (ast: MplAst): ProductComponent => {
    if (isSeparatedListNode(ast) || isListNode(ast)) {
        throw debug('todo');
    }
    if (ast.type != 'typeLiteralComponent') throw debug('wrong as type');
    const unresolved = parseType(ast.children[2]);
    const resolved = resolveIfNecessary(unresolved, []);
    if (!resolved) throw debug('need to make products work as components of other products');
    return {
        name: (ast.children[0] as any).value,
        type: resolved,
    };
};

const parseType = (ast: MplAst): Type | TypeReference => {
    if (isSeparatedListNode(ast) || isListNode(ast)) {
        throw debug('todo');
    }
    switch (ast.type) {
        case 'typeWithArgs': {
            const name = (ast.children[0] as any).value;
            if (name != 'Function') throw debug('Only functions support args right now');
            const list = ast.children[2];
            if (!isSeparatedListNode(list)) throw debug('todo');
            const typeList = list.items.map(parseType);
            return {
                type: {
                    kind: name,
                    arguments: typeList.slice(0, typeList.length - 1),
                    returnType: typeList[typeList.length - 1],
                },
            };
        }
        case 'typeWithoutArgs': {
            const node = ast.children[0];
            if (isSeparatedListNode(node) || isListNode(node)) {
                throw debug('todo');
            }
            if (node.type != 'typeIdentifier') throw debug('Failed to parse type');
            const name = node.value;
            if (typeof name != 'string') throw debug('Failed to parse type');
            switch (name) {
                case 'String':
                case 'Integer':
                case 'Boolean':
                    return { type: { kind: name } };
                default:
                    return { namedType: name };
            }
        }
        case 'typeLiteral': {
            const node = ast.children[1];
            if (!isListNode(node)) {
                throw debug('todo');
            }
            return {
                type: {
                    kind: 'Product',
                    name: ast.type,
                    members: node.items.map(parseTypeLiteralComponent),
                },
            };
        }
        case 'listType': {
            const node = ast.children[0];
            if (isSeparatedListNode(node) || isListNode(node) || node.type != 'typeIdentifier') {
                throw debug('expected a type');
            }
            const listOf: Type = { type: { kind: node.value as 'String' } };
            return { type: { kind: 'List', of: listOf } };
        }
        default:
            throw debug(`${ast.type} unhandled in parseType`);
    }
};

const parseObjectMember = (ast: MplAst): Ast.UninferredObjectMember | 'WrongShapeAst' => {
    if (isSeparatedListNode(ast) || isListNode(ast)) {
        throw debug('todo');
    }
    if (ast.type != 'objectLiteralComponent') {
        {
            throw debug('wsa');
            return 'WrongShapeAst';
        }
    }
    const expression = astFromParseResult(ast.children[2]);
    if (expression == 'WrongShapeAst') {
        {
            throw debug('wsa');
            return 'WrongShapeAst';
        }
    }
    const result: Ast.UninferredObjectMember = {
        name: (ast.children[0] as any).value,
        expression: expression as any, // TODO: write a util to check if its and expression
    };
    return result;
};

let functionId = add(-1, 1);
const astFromParseResult = (ast: MplAst): Ast.UninferredAst | 'WrongShapeAst' => {
    if (isSeparatedListNode(ast) || isListNode(ast)) {
        throw debug('todo');
    }
    switch (ast.type) {
        case 'returnStatement':
            return {
                kind: 'returnStatement',
                expression: astFromParseResult(ast.children[1]),
                sourceLocation: ast.sourceLocation,
            } as Ast.UninferredAst;
        case 'number':
            if (ast.value === undefined) throw debug('ast.value === undefined');
            return {
                kind: 'number',
                value: ast.value as any,
                sourceLocation: ast.sourceLocation,
            };
        case 'identifier':
            if (!ast.value) throw debug('!ast.value');
            return {
                kind: 'identifier',
                value: ast.value as any,
                sourceLocation: ast.sourceLocation,
            };
        case 'product':
            if (!('children' in ast)) throw debug('children not in ast in astFromParseResult');
            return {
                kind: 'product',
                lhs: astFromParseResult(ast.children[0]),
                rhs: astFromParseResult(ast.children[2]),
                sourceLocation: ast.sourceLocation,
            } as Ast.UninferredAst;
        case 'ternary':
            return {
                kind: 'ternary',
                condition: astFromParseResult(ast.children[0]),
                ifTrue: astFromParseResult(ast.children[2]),
                ifFalse: astFromParseResult(ast.children[4]),
                sourceLocation: ast.sourceLocation,
            } as Ast.UninferredAst;
        case 'equality':
            if (!('children' in ast)) throw debug('children not in ast in astFromParseResult');
            return {
                kind: 'equality',
                lhs: astFromParseResult(ast.children[0]),
                rhs: astFromParseResult(ast.children[2]),
                sourceLocation: ast.sourceLocation,
            } as Ast.UninferredAst;
        case 'paramList':
            throw debug('paramList in astFromParseResult'); // Should have been caught in "callExpression"
        case 'callExpression':
            const child2 = ast.children[2];
            if (!isSeparatedListNode(child2)) {
                throw debug('todo');
            }
            return {
                kind: 'callExpression',
                name: (ast.children[0] as any).value as any,
                arguments: child2.items.map(astFromParseResult),
                sourceLocation: ast.sourceLocation,
            } as Ast.UninferredAst;
        case 'subtraction':
            if (!('children' in ast)) throw debug('children not in ast in astFromParseResult');
            return {
                kind: 'subtraction',
                lhs: astFromParseResult(ast.children[0]),
                rhs: astFromParseResult(ast.children[2]),
                sourceLocation: ast.sourceLocation,
            } as Ast.UninferredAst;
        case 'addition':
            if (!('children' in ast)) throw debug('children not in ast in astFromParseResult');
            return {
                kind: 'addition',
                lhs: astFromParseResult(ast.children[0]),
                rhs: astFromParseResult(ast.children[2]),
                sourceLocation: ast.sourceLocation,
            } as Ast.UninferredAst;
        case 'reassignment':
            if (!('children' in ast)) throw debug('children not in ast in astFromParseResult');
            return {
                kind: 'reassignment',
                destination: (ast.children[0] as any).value as any,
                expression: astFromParseResult(ast.children[2]),
                sourceLocation: ast.sourceLocation,
            } as Ast.UninferredAst;
        case 'declaration': {
            let childIndex = 0;
            let exported: boolean = false;
            if ((ast.children[childIndex] as any).type == 'export') {
                exported = true;
                childIndex++;
            }
            const destination = (ast.children[childIndex] as any).value as any;
            childIndex++;
            const destinationNode = ast.children[childIndex];
            if (isSeparatedListNode(destinationNode) || isListNode(destinationNode)) {
                throw debug('todo');
            }
            if (destinationNode.type != 'colon') debug('expected a colon');
            childIndex++;
            let type: Type | TypeReference | undefined = undefined;
            const maybeTypeNode = ast.children[childIndex];
            if (isSeparatedListNode(maybeTypeNode) || isListNode(maybeTypeNode)) {
                throw debug('todo');
            }
            if (
                ['typeWithArgs', 'typeWithoutArgs', 'typeLiteral', 'listType'].includes(
                    maybeTypeNode.type
                )
            ) {
                type = parseType(maybeTypeNode);
                childIndex++;
            }

            if ((ast.children[childIndex] as any).type != 'assignment')
                debug('expected assignment');
            childIndex++;
            const expression = astFromParseResult(ast.children[childIndex]);
            if (type) {
                return {
                    kind: 'typedDeclarationAssignment',
                    destination,
                    expression: expression as any,
                    type,
                    exported,
                    sourceLocation: ast.sourceLocation,
                };
            } else {
                return {
                    kind: 'declarationAssignment',
                    destination,
                    expression: expression as any,
                    exported,
                    sourceLocation: ast.sourceLocation,
                };
            }
        }
        case 'typeDeclaration':
            const theType = parseType(ast.children[3]);
            const name: string = (ast.children[0] as any).value;
            if ('namedType' in theType) {
                throw debug(
                    "Shouldn't get here, delcaring types have to actually declare a type"
                );
            }
            if (theType.type.kind == 'Product') {
                theType.type.name = name;
            }
            return {
                kind: 'typeDeclaration',
                name,
                type: theType,
                sourceLocation: ast.sourceLocation,
            };
        case 'stringLiteral':
            return {
                kind: 'stringLiteral',
                value: ast.value as any,
                sourceLocation: ast.sourceLocation,
            };
        case 'objectLiteral':
            const typeNameNode = ast.children[0];
            if (isSeparatedListNode(typeNameNode) || isListNode(typeNameNode)) {
                throw debug('todo');
            }
            if (typeNameNode.type != 'typeIdentifier') return 'WrongShapeAst';
            const typeName = typeNameNode.value;
            if (typeof typeName != 'string') return 'WrongShapeAst';
            const membersNode = ast.children[2];
            if (!isListNode(membersNode)) {
                throw debug('todo');
            }
            const members = membersNode.items.map(parseObjectMember);
            if (members.some(m => m == 'WrongShapeAst')) return 'WrongShapeAst';
            return {
                kind: 'objectLiteral',
                typeName,
                members: members as any,
                sourceLocation: ast.sourceLocation,
            };
        case 'memberStyleCall': {
            const anyAst = ast as any;
            const lhsNode = anyAst.children[0];
            const lhs = astFromParseResult(lhsNode);
            if (lhs == 'WrongShapeAst') {
                return 'WrongShapeAst';
            }
            const memberName = anyAst.children[2].value;
            const params = anyAst.children[4].items.map(astFromParseResult);
            if (params == 'WrongShapeAst') {
                return 'WrongShapeAst';
            }
            const r: Ast.UninferredMemberStyleCall = {
                kind: 'memberStyleCall',
                lhs: lhs as Ast.UninferredExpression,
                memberName,
                params: params as Ast.UninferredExpression[],
                sourceLocation: ast.sourceLocation,
            };
            return r;
        }
        case 'memberAccess': {
            const anyAst = ast as any;
            const lhsNode = anyAst.children[0];
            const lhs = astFromParseResult(lhsNode);
            return {
                kind: 'memberAccess',
                lhs,
                rhs: anyAst.children[2].value,
                sourceLocation: ast.sourceLocation,
            } as Ast.UninferredAst;
        }
        case 'concatenation':
            if (!('children' in ast)) throw debug('children not in ast in astFromParseResult');
            return {
                kind: 'concatenation',
                lhs: astFromParseResult(ast.children[0]),
                rhs: astFromParseResult(ast.children[2]),
                sourceLocation: ast.sourceLocation,
            } as Ast.UninferredAst;
        case 'equality':
            if (!('children' in ast)) throw debug('children not in ast in astFromParseResult');
            return {
                kind: 'equality',
                lhs: astFromParseResult(ast.children[0]),
                rhs: astFromParseResult(ast.children[2]),
                sourceLocation: ast.sourceLocation,
            } as Ast.UninferredAst;
        case 'function': {
            functionId++;

            let childIndex = 0;
            let hasBrackets = false;
            if (hasType(ast.children[0], 'leftBracket')) {
                childIndex++;
                hasBrackets = true;
            }
            const parameters: VariableDeclaration[] = extractParameterList(
                ast.children[childIndex]
            );
            childIndex++;

            if (hasBrackets) {
                if (!hasType(ast.children[childIndex], 'rightBracket')) {
                    debug('mismatched brackets');
                }
                childIndex++;
            }

            if (!hasType(ast.children[childIndex], 'fatArrow')) debug('wrong');
            childIndex++;
            return {
                kind: 'functionLiteral',
                deanonymizedName: `anonymous_${functionId}`,
                body: [
                    {
                        kind: 'returnStatement',
                        expression: astFromParseResult(ast.children[childIndex]),
                        sourceLocation: ast.sourceLocation,
                    },
                ],
                parameters,
                sourceLocation: ast.sourceLocation,
            } as Ast.UninferredAst;
        }
        case 'functionWithBlock': {
            functionId++;
            let childIndex = 0;
            let hasBrackets = false;
            if (hasType(ast.children[childIndex], 'leftBracket')) {
                hasBrackets = true;
                childIndex++;
            }
            const parameters2: VariableDeclaration[] = extractParameterList(
                ast.children[childIndex]
            );
            childIndex++;

            if (hasBrackets) {
                if (!hasType(ast.children[childIndex], 'rightBracket')) {
                    debug('brackets mismatched');
                }
                childIndex++;
            }
            if (!hasType(ast.children[childIndex], 'fatArrow')) debug('wrong');
            childIndex++;
            if (!hasType(ast.children[childIndex], 'leftCurlyBrace')) debug('wrong');
            childIndex++;
            const body = extractFunctionBody(ast.children[childIndex]);
            childIndex++;
            if (!hasType(ast.children[childIndex], 'rightCurlyBrace')) debug('wrong');
            childIndex++;
            if (childIndex !== ast.children.length) debug('wrong');
            return {
                kind: 'functionLiteral',
                deanonymizedName: `anonymous_${functionId}`,
                body,
                parameters: parameters2,
                sourceLocation: ast.sourceLocation,
            };
        }
        case 'booleanLiteral':
            return {
                kind: 'booleanLiteral',
                value: ast.value == 'true',
                sourceLocation: ast.sourceLocation,
            };
        case 'program':
            return {
                kind: 'program',
                statements: extractFunctionBody(ast.children[0]),
                sourceLocation: ast.sourceLocation,
            };
        case 'listLiteral':
            const items = ast.children[1];
            if (!isSeparatedListNode(items)) throw debug('todo');
            return {
                kind: 'listLiteral',
                items: items.items.map(astFromParseResult) as Ast.UninferredExpression[],
                sourceLocation: ast.sourceLocation,
            };
        case 'indexAccess':
            return {
                kind: 'indexAccess',
                index: astFromParseResult(ast.children[2]) as Ast.UninferredExpression,
                accessed: astFromParseResult(ast.children[0]) as Ast.UninferredExpression,
                sourceLocation: ast.sourceLocation,
            };
        default:
            throw debug(`${ast.type} unhandled in astFromParseResult`);
    }
};

const compile = (
    source: string
):
    | FrontendOutput
    | { parseErrors: ParseError[] }
    | { typeErrors: TypeError[] }
    | LexError
    | { internalError: string } => {
    functionId = 0;
    const tokens = lex<MplToken>(tokenSpecs, source);
    if ('kind' in tokens) {
        return tokens;
    }

    const parseResult = parseMpl(tokens);

    if (Array.isArray(parseResult)) {
        return { parseErrors: parseResult };
    }

    const ast = astFromParseResult(parseResult);

    if (ast == 'WrongShapeAst') {
        return { internalError: 'Wrong shape AST' };
    }

    if (ast.kind !== 'program') {
        return { internalError: 'AST was not a program' };
    }

    const exportedDeclarations = ast.statements.filter(
        s =>
            (s.kind == 'typedDeclarationAssignment' || s.kind == 'declarationAssignment') &&
            s.exported
    );

    const topLevelStatements = ast.statements.filter(
        s => s.kind != 'typedDeclarationAssignment' && s.kind != 'declarationAssignment'
    );

    if (exportedDeclarations.length > 0 && topLevelStatements.length > 0) {
        return {
            typeErrors: [
                {
                    kind: 'topLevelStatementsInModule',
                    sourceLocation: topLevelStatements[0].sourceLocation,
                },
            ],
        };
    }

    const availableTypes = walkAst<TypeDeclaration, Ast.UninferredTypeDeclaration>(
        ast,
        ['typeDeclaration'],
        n => n
    );

    let availableVariables = builtinFunctions;
    const program: UninferredFunction = {
        name: 'main_program',
        statements: ast.statements,
        variables: extractVariables({ w: ast.statements, availableVariables, availableTypes }),
        parameters: [],
    };

    const functions = walkAst<UninferredFunction, Ast.UninferredFunctionLiteral>(
        ast,
        ['functionLiteral'],
        astNode => functionObjectFromAst({ w: astNode, availableVariables, availableTypes })
    );

    const stringLiteralIdMaker = idMaker();
    const nonUniqueStringLiterals = walkAst<StringLiteralData, Ast.StringLiteral>(
        ast,
        ['stringLiteral'],
        (astNode: Ast.StringLiteral) => ({ id: stringLiteralIdMaker(), value: astNode.value })
    );

    const stringLiterals: StringLiteralData[] = uniqueBy(s => s.value, nonUniqueStringLiterals);
    const programTypeCheck = typeCheckFunction({
        w: program,
        availableVariables,
        availableTypes,
    });
    availableVariables = mergeDeclarations(availableVariables, programTypeCheck.identifiers);

    const typeErrors: TypeError[][] = functions.map(
        f => typeCheckFunction({ w: f, availableVariables, availableTypes }).typeErrors
    );
    typeErrors.push(programTypeCheck.typeErrors);

    let flatTypeErrors: TypeError[] = flatten(typeErrors);
    if (flatTypeErrors.length > 0) {
        return { typeErrors: flatTypeErrors };
    }

    const typedFunctions: Function[] = [];
    functions.forEach(f => {
        const functionOrTypeError = inferFunction({ w: f, availableVariables, availableTypes });
        if (isTypeError(functionOrTypeError)) {
            typeErrors.push(functionOrTypeError);
        } else {
            typedFunctions.push({
                ...f,
                returnType: functionOrTypeError.returnType,
                statements: f.statements.map(s =>
                    infer({
                        w: s,
                        availableVariables: mergeDeclarations(availableVariables, f.variables),
                        availableTypes,
                    })
                ) as Ast.Statement[],
            });
        }
    });

    flatTypeErrors = flatten(typeErrors);
    if (flatTypeErrors.length > 0) {
        return { typeErrors: flatTypeErrors };
    }

    const globalDeclarations: GlobalVariable[] = program.statements
        .filter(
            s => s.kind === 'typedDeclarationAssignment' || s.kind === 'declarationAssignment'
        )
        .map(assignment =>
            assignmentToGlobalDeclaration({
                w: assignment as any,
                availableVariables,
                availableTypes,
            })
        );
    let inferredProgram: Function | ExportedVariable[] | undefined = undefined;

    if (exportedDeclarations.length == 0) {
        const maybeInferredProgram = inferFunction({
            w: program,
            availableVariables,
            availableTypes,
        });
        if (isTypeError(maybeInferredProgram)) {
            return { typeErrors: maybeInferredProgram };
        }
        inferredProgram = maybeInferredProgram;

        if (!typesAreEqual(inferredProgram.returnType, builtinTypes.Integer)) {
            const returnStatement = last(inferredProgram.statements);
            return {
                typeErrors: [
                    {
                        kind: 'wrongTypeReturn',
                        expressionType: inferredProgram.returnType,
                        sourceLocation: returnStatement
                            ? returnStatement.sourceLocation
                            : { line: 1, column: 1 },
                    },
                ],
            };
        }
    } else {
        inferredProgram = globalDeclarations.map(d => ({
            exportedName: d.name,
            declaredName: d.mangledName || '',
        }));
    }

    return {
        types: availableTypes,
        functions: typedFunctions,
        builtinFunctions,
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
    astFromParseResult,
    mergeDeclarations,
};
