import { zipWith } from 'lodash';
import uniqueBy from './util/list/uniqueBy';
import idMaker from './util/idMaker';
import last from './util/list/last';
import debug from './util/debug';
import never from './util/never';
import { lex, Token, LexError } from './parser-lib/lex';
import { tokenSpecs, grammar, MplAst, MplParseResult, MplToken } from './grammar';
import { parseResultIsError, parse, isSeparatedListNode, isListNode } from './parser-lib/parse';
import ParseError from './parser-lib/ParseError';
import {
    Type,
    ProductComponent,
    equal as typesAreEqual,
    resolve,
    builtinTypes,
    Product,
    List,
    Function as FunctionType,
    builtinFunctions,
    TypeDeclaration,
    TypeReference,
    Method,
} from './types';
import { Variable, Function, FrontendOutput, StringLiteralData, getTypeOfFunction } from './api';
import { TypeError } from './TypeError';
import * as Ast from './ast';
import * as PFAst from './postFunctionExtractionAst';
import { deepCopy } from 'deep-copy-ts';
/* tslint:disable */
const { add } = require('./mpl/add.mpl');
/* tslint:enable */

const repairAssociativity = (nodeType, ast) => {
    // Let this slide because TokenType overlaps InteriorNodeType right now
    if (ast.type === nodeType && !ast.sequenceItems) /*debug('todo')*/ return ast;
    if (ast.type === nodeType) {
        const [lhs, op, rhs] = ast.sequenceItems;
        if (rhs.type === nodeType) {
            const [rhslhs, rhsop, rhsrhs] = rhs.sequenceItems;
            return {
                type: nodeType,
                sequenceItems: [
                    {
                        type: nodeType,
                        sequenceItems: [
                            repairAssociativity(nodeType, lhs),
                            rhsop,
                            repairAssociativity(nodeType, rhslhs),
                        ],
                        sourceLocation: ast.sourceLocation,
                    },
                    op,
                    repairAssociativity(nodeType, rhsrhs),
                ],
                sourceLocation: ast.sourceLocation,
            };
        } else {
            return {
                type: ast.type,
                sequenceItems: ast.sequenceItems.map(child =>
                    repairAssociativity(nodeType, child)
                ),
                sourceLocation: ast.sourceLocation,
            };
        }
    } else if ('sequenceItems' in ast) {
        return {
            type: ast.type,
            sequenceItems: ast.sequenceItems.map(child => repairAssociativity(nodeType, child)),
            sourceLocation: ast.sourceLocation,
        };
    } else if ('items' in ast) {
        return { ...ast, items: ast.items.map(item => repairAssociativity(nodeType, item)) };
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
        if ('sequenceItems' in newNode) {
            // If we aren't supposed to recurse, don't re-tranform the node we just made
            if (recurseOnNew) {
                return transformAst(nodeType, f, newNode, recurseOnNew);
            } else {
                return {
                    type: newNode.type,
                    sequenceItems: newNode.sequenceItems.map(child =>
                        transformAst(nodeType, f, child, recurseOnNew)
                    ),
                    sourceLocation: ast.sourceLocation,
                };
            }
        } else {
            return newNode;
        }
    } else if ('sequenceItems' in ast) {
        return {
            type: ast.type,
            sequenceItems: ast.sequenceItems.map(child =>
                transformAst(nodeType, f, child, recurseOnNew)
            ),
            sourceLocation: ast.sourceLocation,
        };
    } else {
        return ast;
    }
};

const extractVariable = (
    ctx: WithContext<PFAst.PostFunctionExtractionStatement>,
    extractedFunctions: Map<String, PFAst.ExtractedFunction>
): Variable | undefined => {
    const kind = ctx.w.kind;
    switch (ctx.w.kind) {
        case 'reassignment':
        case 'declarationAssignment':
            // Recursive functions can refer to the left side on the right side, so to extract
            // the left side, we need to know about the right side. Probably, this just shouldn't return
            // a type. TODO: allow more types of recursive functions than just single int...
            return {
                name: ctx.w.destination,
                type: (
                    typeOfExpression(
                        { ...ctx, w: ctx.w.expression },
                        extractedFunctions
                    ) as TOEResult
                ).type,
                exported: false,
            };
        case 'typedDeclarationAssignment':
            const resolved = resolve(ctx.w.type, ctx.availableTypes, ctx.w.sourceLocation);
            if ('errors' in resolved) throw debug('expected no error');
            return {
                name: ctx.w.destination,
                type: (
                    typeOfExpression(
                        { ...ctx, w: ctx.w.expression },
                        extractedFunctions,
                        resolved
                    ) as TOEResult
                ).type,
                exported: false,
            };
        case 'returnStatement':
        case 'typeDeclaration':
            return undefined;
        case 'forLoop':
            throw debug("forLoop has muliple variables, doesn't work here");
        default:
            never(kind as never, 'extractVariable');
    }
};

const extractVariables = (
    ctx: WithContext<PFAst.PostFunctionExtractionStatement[]>,
    extractedFunctions: Map<String, PFAst.ExtractedFunction>
): Variable[] => {
    const variables: Variable[] = [];
    ctx.w.forEach((statement: PFAst.PostFunctionExtractionStatement) => {
        switch (statement.kind) {
            case 'returnStatement':
            case 'reassignment':
            case 'typeDeclaration':
                break;
            case 'declarationAssignment':
            case 'typedDeclarationAssignment':
                const potentialVariable = extractVariable(
                    {
                        w: statement,
                        availableVariables: mergeDeclarations(ctx.availableVariables, variables),
                        availableTypes: ctx.availableTypes,
                    },
                    extractedFunctions
                );
                if (potentialVariable) {
                    variables.push(potentialVariable);
                }
                break;
            case 'forLoop':
                statement.body.forEach(s => {
                    const vars = extractVariables(
                        {
                            w: [s],
                            availableVariables: mergeDeclarations(
                                ctx.availableVariables,
                                variables
                            ),
                            availableTypes: ctx.availableTypes,
                        },
                        extractedFunctions
                    );
                    if (vars) {
                        variables.push(...vars);
                    }
                });
                break;
            default:
                never(statement, 'extractVariables');
        }
    });
    return variables;
};

const functionObjectFromAst = (
    ctx: WithContext<PFAst.ExtractedFunction>,
    extractedFunctions: Map<String, PFAst.ExtractedFunction>
): PFAst.ExtractedFunctionWithVariables => ({
    sourceLocation: ctx.w.sourceLocation,
    statements: ctx.w.statements,
    variables: [
        ...ctx.w.parameters,
        ...extractVariables(
            {
                w: ctx.w.statements,
                availableVariables: mergeDeclarations(ctx.availableVariables, ctx.w.parameters),
                availableTypes: ctx.availableTypes,
            },
            extractedFunctions
        ),
    ],
    parameters: ctx.w.parameters,
});

const walkAst = <ReturnType, NodeType extends Ast.PreFunctionExtractionAst>(
    ast: Ast.PreFunctionExtractionAst,
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
            return [...result, ...ast.arguments.map(recurse).flat()];
        case 'ternary':
            return [
                ...result,
                ...recurse(ast.condition)
                    .concat(recurse(ast.ifTrue))
                    .concat(recurse(ast.ifFalse)),
            ];
        case 'program':
            return [...result, ...ast.statements.map(recurse).flat()];
        case 'functionLiteral':
            return [...result, ...ast.body.map(recurse).flat()];
        case 'objectLiteral':
            return [...result, ...ast.members.map(member => recurse(member.expression)).flat()];
        case 'memberAccess':
            return [...result, ...recurse(ast.lhs)];
        case 'number':
        case 'identifier':
        case 'stringLiteral':
        case 'booleanLiteral':
        case 'typeDeclaration':
            return result;
        case 'listLiteral':
            return [...result, ...ast.items.map(recurse).flat()];
        case 'indexAccess':
            return [...result, ...recurse(ast.accessed), ...recurse(ast.index)];
        case 'memberStyleCall':
            return [...result, ...recurse(ast.lhs), ...ast.params.map(recurse).flat()];
        case 'forLoop':
            return [...result, ...recurse(ast.list), ...ast.body.map(recurse).flat()];
        default:
            throw debug(`${(ast as any).kind} unhandled in walkAst`);
    }
};

const removeBracketsFromAst = ast =>
    transformAst('bracketedExpression', node => node.sequenceItems[0], ast, true);

const parseMpl = (tokens: Token<MplToken>[]): MplAst | ParseError[] => {
    const parseResult: MplParseResult = parse(grammar, 'program', tokens);

    if (parseResultIsError(parseResult)) {
        // TODO: Just get the parser to give us good errors directly instead of taking the first
        return [parseResult.errors[0]];
    }
    let ast = parseResult;

    // TODO: This needs some more work given the new way binary expressions work
    ast = repairAssociativity('binaryExpression', ast);

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
    ctx: WithContext<PFAst.PostFunctionExtractionExpression>,
    extractedFunctions: Map<String, PFAst.ExtractedFunction>,
    expectedType: Type | undefined = undefined
): TOEResult | TypeError[] => {
    const recurse = ast2 => typeOfExpression({ ...ctx, w: ast2 }, extractedFunctions);
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
        case 'functionReference': {
            const functionAst = extractedFunctions[ast.value || (ast as any).name];
            if (functionAst === undefined) {
                throw debug('bad function ref');
            }
            const functionObject = functionObjectFromAst(
                { ...ctx, w: functionAst },
                extractedFunctions
            );
            const f = inferFunction(
                {
                    w: functionObject,
                    availableVariables: mergeDeclarations(
                        ctx.availableVariables,
                        functionObject.variables
                    ),
                    availableTypes: ctx.availableTypes,
                },
                extractedFunctions
            );
            if (isTypeError(f)) {
                return f;
            }
            return {
                type: FunctionType(
                    functionAst.parameters
                        .map(p => p.type)
                        .map(t => {
                            const resolved = resolve(
                                t,
                                ctx.availableTypes,
                                ctx.w.sourceLocation
                            );
                            if ('errors' in resolved) {
                                throw debug('bag argument. This should be a better error.');
                            }
                            return resolved;
                        }),
                    [],
                    f.returnType
                ),
                extractedFunctions: [f], // TODO: Add functions extracted within the function itself
            };
        }
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
                let argType = functionType.type.arguments[i];
                // TODO: Something is putting invalid data into the function type, find out what, fix it, then eliminate this.
                if (!('methods' in argType)) {
                    argType = (argType as any).type as any;
                }
                if (!('methods' in argType)) {
                    throw debug('bad type');
                }
                const resolved = resolve(argType, ctx.availableTypes, ast.sourceLocation);
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
            const returnType = resolve(
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

            const lookupMemberFunction = (
                methodName: string,
                calleeType: Type
            ): Type | { errors: TypeError[]; newVariables: Variable[] } => {
                const method = calleeType.methods.find(m => m.name == methodName);
                if (method) return method.function;
                const variable = availableVariables.find(
                    ({ name: varName }) => methodName == varName
                );
                if (!variable) {
                    return {
                        errors: [
                            {
                                kind: 'unknownIdentifier',
                                name: functionName,
                                sourceLocation: ast.sourceLocation,
                            },
                        ],
                        newVariables: [],
                    };
                }
                return resolve(variable.type, availableTypes, ast.sourceLocation);
            };

            const functionName = ast.memberName;
            const declaration = lookupMemberFunction(functionName, thisArgType.type);
            if ('errors' in declaration) {
                return declaration.errors;
            }

            const functionType = declaration;
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
                const resolved = resolve(
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
            const returnType = resolve(
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
            const declaration = resolve(unresolved.type, availableTypes, ast.sourceLocation);
            if ('errors' in declaration) {
                return declaration.errors;
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
            const typeErrors: TypeError[] = memberTypes.filter(isTypeError).flat();
            if (!(typeErrors.length == 0)) return typeErrors;
            return {
                type: {
                    ...Product(
                        ast.members.map(({ name, expression }) => ({
                            name,
                            type: (recurse(expression) as TOEResult).type,
                        })),
                        []
                    ),
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
        case 'listLiteral': {
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
            return { type: List(innerType), extractedFunctions };
        }
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
    ctx: WithContext<PFAst.PostFunctionExtractionStatement>,
    extractedFunctions: Map<String, PFAst.ExtractedFunction>
): { errors: TypeError[]; newVariables: Variable[] } => {
    const { w, availableTypes, availableVariables } = ctx;
    const ast = w;
    if (!ast.kind) debug('!ast.kind');
    switch (ast.kind) {
        case 'returnStatement': {
            const result = typeOfExpression({ ...ctx, w: ast.expression }, extractedFunctions);
            if (isTypeError(result)) {
                return { errors: result, newVariables: [] };
            }
            return { errors: [], newVariables: [] };
        }
        case 'declarationAssignment': {
            const rightType = typeOfExpression(
                {
                    w: ast.expression,
                    availableTypes,
                    availableVariables: mergeDeclarations(availableVariables, [
                        {
                            name: ast.destination,
                            type: FunctionType([builtinTypes.Integer], [], builtinTypes.Integer),
                            exported: false,
                        },
                    ]),
                },
                extractedFunctions
            );
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
            const rightType = typeOfExpression(
                { ...ctx, w: ast.expression },
                extractedFunctions
            );
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
            const leftType = resolve(
                unresolvedLeftType.type,
                availableTypes,
                ast.sourceLocation
            );
            if ('errors' in leftType) {
                return leftType;
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
            const resolvedDestination = resolve(
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
                extractedFunctions,
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
        case 'forLoop': {
            const expressionType = typeOfExpression({ ...ctx, w: ast.list }, extractedFunctions);
            if (isTypeError(expressionType)) {
                return { errors: expressionType, newVariables: [] };
            }
            if (expressionType.type.type.kind != 'List') {
                return {
                    errors: [
                        {
                            kind: 'nonListInFor',
                            found: expressionType.type,
                            sourceLocation: ast.sourceLocation,
                        },
                    ],
                    newVariables: [],
                };
            }
            const newVariables: Variable[] = [];
            for (const statement of ast.body) {
                const statementType = typeCheckStatement(
                    { ...ctx, w: statement },
                    extractedFunctions
                );
                if (isTypeError(statementType)) {
                    return { errors: statementType, newVariables: [] };
                }
                newVariables.push(...statementType.newVariables);
            }
            return { errors: [], newVariables };
        }
        default:
            throw never(ast, 'typeCheckStatement');
    }
};

const mergeDeclarations = (left: Variable[], right: Variable[]): Variable[] => {
    const result = [...right];
    left.forEach(declaration => {
        if (!result.some(({ name }) => name == declaration.name)) {
            result.unshift(declaration);
        }
    });
    return result;
};

const typeCheckFunction = (
    ctx: WithContext<PFAst.ExtractedFunction>,
    extractedFunctions: Map<String, PFAst.ExtractedFunction>
) => {
    let availableVariables = mergeDeclarations(ctx.availableVariables, ctx.w.parameters);
    const allErrors: any = [];
    ctx.w.statements.forEach(statement => {
        if (allErrors.length == 0) {
            const { errors, newVariables } = typeCheckStatement(
                {
                    ...ctx,
                    w: statement,
                    availableVariables,
                },
                extractedFunctions
            );
            availableVariables = mergeDeclarations(availableVariables, newVariables);
            allErrors.push(...errors);
        }
    });
    return { typeErrors: allErrors, identifiers: availableVariables };
};

const assignmentToGlobalDeclaration = (
    ctx: WithContext<PFAst.PostFunctionExtractionDeclarationAssignment>,
    extractedFunctions: Map<String, PFAst.ExtractedFunction>
): Variable => {
    const result = typeOfExpression({ ...ctx, w: ctx.w.expression }, extractedFunctions);
    if (isTypeError(result)) throw debug('isTypeError in assignmentToGlobalDeclaration');
    return {
        name: ctx.w.destination,
        type: result.type,
        exported: ctx.w.exported,
    };
};

type WithContext<T> = {
    w: T;
    availableTypes: TypeDeclaration[];
    availableVariables: Variable[];
};

const inModule = (ctx: WithContext<PFAst.ExtractedFunction>): boolean => {
    for (const s of ctx.w.statements) {
        if (s.kind == 'declarationAssignment' || s.kind == 'typedDeclarationAssignment') {
            if (s.exported) {
                return true;
            }
        }
    }
    return false;
};

const inferFunction = (
    ctx: WithContext<PFAst.ExtractedFunctionWithVariables>,
    extractedFunctions: Map<String, PFAst.ExtractedFunction>
): Function | TypeError[] => {
    const variablesFound = mergeDeclarations(ctx.availableVariables, ctx.w.parameters);
    const statements: Ast.Statement[] = [];
    ctx.w.statements.forEach(statement => {
        const statementsContext: WithContext<PFAst.PostFunctionExtractionStatement[]> = {
            w: [statement],
            availableVariables: variablesFound,
            availableTypes: ctx.availableTypes,
        };
        const statementContext: WithContext<PFAst.PostFunctionExtractionStatement> = {
            w: statement,
            availableVariables: variablesFound,
            availableTypes: ctx.availableTypes,
        };
        variablesFound.push(...extractVariables(statementsContext, extractedFunctions));
        statements.push(infer(statementContext, extractedFunctions) as Ast.Statement);
    });
    if (inModule(ctx)) {
        return {
            statements,
            variables: ctx.w.variables,
            parameters: ctx.w.parameters,
            returnType: builtinTypes.Integer,
        };
    } else {
        const maybeReturnStatement = last(ctx.w.statements);
        if (!maybeReturnStatement) {
            return [{ kind: 'missingReturn', sourceLocation: { line: 0, column: 0 } }];
        }
        if (maybeReturnStatement.kind != 'returnStatement') {
            return [
                { kind: 'missingReturn', sourceLocation: maybeReturnStatement.sourceLocation },
            ];
        }
        const returnStatement = maybeReturnStatement;
        const returnType = typeOfExpression(
            {
                ...ctx,
                availableVariables: variablesFound,
                w: returnStatement.expression,
            },
            extractedFunctions
        );
        if (isTypeError(returnType)) {
            return returnType;
        }
        return {
            statements,
            variables: ctx.w.variables,
            parameters: ctx.w.parameters,
            returnType: returnType.type,
        };
    }
};

// TODO: merge this with typecheck maybe?
const infer = (
    ctx: WithContext<PFAst.PostFunctionExtractionAst>,
    extractedFunctions: Map<String, PFAst.ExtractedFunction>
): Ast.Ast => {
    const recurse = ast2 => infer({ ...ctx, w: ast2 }, extractedFunctions);
    const { w, availableVariables, availableTypes } = ctx;
    const ast = w;
    switch (ast.kind) {
        case 'returnStatement':
            return {
                kind: 'returnStatement',
                expression: recurse(ast.expression),
                sourceLocation: ast.sourceLocation,
            };
        case 'forLoop':
            return {
                kind: 'forLoop',
                sourceLocation: ast.sourceLocation,
                var: ast.var,
                list: recurse(ast.list),
                body: ast.body.map(recurse) as Ast.Statement[],
            };
        case 'equality':
            const equalityType = typeOfExpression({ ...ctx, w: ast.lhs }, extractedFunctions);
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
            const resolved = resolve(ast.type, availableTypes, ast.sourceLocation);
            if ('errors' in resolved) throw debug("resolution shouldn't fail here");
            return {
                kind: 'typedDeclarationAssignment',
                sourceLocation: ast.sourceLocation,
                expression: recurse(ast.expression),
                type: resolved,
                destination: ast.destination,
            };
        case 'declarationAssignment':
            const type = typeOfExpression({ ...ctx, w: ast.expression }, extractedFunctions);
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
            const accessedType = typeOfExpression(
                {
                    w: ast.lhs,
                    availableVariables,
                    availableTypes,
                },
                extractedFunctions
            );
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
                    const maybeItemType = typeOfExpression(
                        {
                            w: item,
                            availableVariables,
                            availableTypes,
                        },
                        extractedFunctions
                    );
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
                type: List(itemType),
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
        case 'functionReference':
            return {
                kind: 'functionReference',
                sourceLocation: ast.sourceLocation,
                name: ast.value,
            };
        default:
            throw debug(`${ast.kind} unhandled in infer`);
    }
};

const extractFunctionBody = (node): any[] => {
    return node.items.map(astFromParseResult);
};

// TODO: Replace extractParameterList with SeparatedList
const extractParameterList = (ast: MplAst): Variable[] => {
    if (isSeparatedListNode(ast)) {
        return ast.items
            .map(i => {
                if (isSeparatedListNode(i) || !('sequenceItems' in i)) {
                    throw debug('todo');
                }
                const child2 = i.sequenceItems[2];
                if (isSeparatedListNode(child2) || isListNode(child2)) {
                    throw debug('todo');
                }
                return [
                    {
                        name: (i.sequenceItems[0] as any).value as string,
                        type: parseType(child2),
                        exported: false,
                    },
                ];
            })
            .flat();
    } else {
        throw debug(`${(ast as any).type} unhandledi extractParameterList`);
    }
};

const parseTypeLiteralComponent = (ast: MplAst): ProductComponent => {
    if (isSeparatedListNode(ast) || isListNode(ast)) {
        throw debug('todo');
    }
    if (ast.type != 'typeLiteralComponent') throw debug('wrong as type');
    const unresolved = parseType(ast.sequenceItems[2]);
    const resolved = resolve(unresolved, [], ast.sourceLocation);
    if ('errors' in resolved) {
        throw debug('need to make products work as components of other products');
    }
    return {
        name: (ast.sequenceItems[0] as any).value,
        type: resolved,
    };
};

const parseMethodDefinition = (ast: MplAst): Method => {
    if (!('sequenceItems' in ast)) {
        throw debug('todo');
    }
    const [name, args, _statements, _sep] = ast.sequenceItems;
    // TODO: Use the statements actually
    return {
        name: (name as any).value,
        function: {
            type: {
                kind: 'Function',
                permissions: [],
                arguments: ['ImplicitThis', ...(args as any).items.map(astFromParseResult)],
                returnType: builtinTypes.Boolean,
            },
            methods: [],
        },
    };
};

const parseType = (ast: MplAst): Type | TypeReference => {
    if (isSeparatedListNode(ast)) {
        throw debug('todo');
    }
    if (isListNode(ast)) {
        return Product(ast.items.map(parseTypeLiteralComponent), []);
    }
    switch (ast.type) {
        case 'typeWithArgs': {
            const [name, list] = ast.sequenceItems as any;
            if (name.value != 'Function') throw debug('Only functions support args right now');
            if (!isSeparatedListNode(list)) throw debug('todo');
            const typeList = list.items.map(parseType);
            return FunctionType(
                typeList.slice(0, typeList.length - 1),
                [],
                typeList[typeList.length - 1]
            );
        }
        case 'typeWithoutArgs': {
            const [node] = ast.sequenceItems;
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
                    return builtinTypes[name];
                default:
                    return { namedType: name };
            }
        }
        case 'listType': {
            const [node, _lb, _rb] = ast.sequenceItems;
            if (isSeparatedListNode(node) || isListNode(node) || node.type != 'typeIdentifier') {
                throw debug('expected a type');
            }
            return List({ type: { kind: node.value as any }, methods: [] });
        }
        case 'typeLiteral': {
            const [members, methods] = ast.sequenceItems;
            if (!isListNode(members)) {
                throw debug('expected a list');
            }
            if (!isListNode(methods)) {
                throw debug('expected a list');
            }
            return Product(
                members.items.map(parseTypeLiteralComponent),
                methods.items.map(parseMethodDefinition)
            );
        }
        default:
            throw debug(`${ast.type} unhandled in parseType`);
    }
};

const parseObjectMember = (
    ast: MplAst
): Ast.PreFunctionExtractionObjectMember | 'WrongShapeAst' => {
    if (isSeparatedListNode(ast) || isListNode(ast)) {
        throw debug('todo');
    }
    if (ast.type != 'objectLiteralComponent') {
        {
            throw debug('wsa');
            return 'WrongShapeAst';
        }
    }
    const expression = astFromParseResult(ast.sequenceItems[2]);
    if (expression == 'WrongShapeAst') {
        {
            throw debug('wsa');
            return 'WrongShapeAst';
        }
    }
    const result: Ast.PreFunctionExtractionObjectMember = {
        name: (ast.sequenceItems[0] as any).value,
        expression: expression as any, // TODO: write a util to check if its and expression
    };
    return result;
};

let functionId = add(-1, 1);
const astFromParseResult = (ast: MplAst): Ast.PreFunctionExtractionAst | 'WrongShapeAst' => {
    if (isSeparatedListNode(ast) || isListNode(ast)) {
        throw debug('todo');
    }
    switch (ast.type) {
        case 'returnStatement':
            const [_return, expr] = ast.sequenceItems;
            return {
                kind: 'returnStatement',
                expression: astFromParseResult(expr),
                sourceLocation: ast.sourceLocation,
            } as Ast.PreFunctionExtractionAst;
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
        case 'ternary':
            const [condition, _question, ifTrue, _colon, ifFalse] = ast.sequenceItems;
            return {
                kind: 'ternary',
                condition: astFromParseResult(condition),
                ifTrue: astFromParseResult(ifTrue),
                ifFalse: astFromParseResult(ifFalse),
                sourceLocation: ast.sourceLocation,
            } as Ast.PreFunctionExtractionAst;
        case 'equality': {
            if (!('sequenceItems' in ast))
                throw debug('children not in ast in astFromParseResult');
            const [lhs, _equal, rhs] = ast.sequenceItems;
            return {
                kind: 'equality',
                lhs: astFromParseResult(lhs),
                rhs: astFromParseResult(rhs),
                sourceLocation: ast.sourceLocation,
            } as Ast.PreFunctionExtractionAst;
        }
        case 'paramList':
            throw debug('paramList in astFromParseResult'); // Should have been caught in "callExpression"
        case 'callExpression':
            const [fn, _lb, args, _rb] = ast.sequenceItems as any;
            return {
                kind: 'callExpression',
                name: fn.value,
                arguments: args.items.map(astFromParseResult),
                sourceLocation: ast.sourceLocation,
            } as Ast.PreFunctionExtractionAst;
        case 'binaryExpression':
            if (!('sequenceItems' in ast))
                throw debug('children not in ast in astFromParseResult');
            const getKind = t => {
                switch (t) {
                    case 'sum':
                        return 'addition';
                    case 'subtraction':
                        return 'subtraction';
                    case 'product':
                        return 'product';
                    case 'equality':
                        return 'equality';
                    default:
                        throw debug('unhandled in getKind');
                }
            };
            const [lhs, kind, rhs] = ast.sequenceItems;
            return {
                kind: getKind((kind as any).type),
                lhs: astFromParseResult(lhs),
                rhs: astFromParseResult(rhs),
                sourceLocation: ast.sourceLocation,
            } as Ast.PreFunctionExtractionAst;
        case 'reassignment': {
            if (!('sequenceItems' in ast))
                throw debug('children not in ast in astFromParseResult');
            const [to, _assign, expr] = ast.sequenceItems as any;
            return {
                kind: 'reassignment',
                destination: to.value as any,
                expression: astFromParseResult(expr),
                sourceLocation: ast.sourceLocation,
            } as Ast.PreFunctionExtractionAst;
        }
        case 'declaration': {
            const [export_, name, _colon, type_, _assign, expr] = ast.sequenceItems as any;
            let exported: boolean = export_.item !== undefined;
            const destination = name.value as any;
            let type: Type | TypeReference | undefined = undefined;
            if (type_.item !== undefined) {
                type = parseType(type_.item);
            }

            const expression = astFromParseResult(expr);
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
        case 'typeDeclaration': {
            const [id, _colon, _assignment, type] = ast.sequenceItems as any;
            const theType = parseType(type);
            const name: string = id.value;
            if ('namedType' in theType) {
                throw debug(
                    "Shouldn't get here, delcaring types have to actually declare a type"
                );
            }
            return {
                kind: 'typeDeclaration',
                name,
                type: theType,
                sourceLocation: ast.sourceLocation,
            };
        }
        case 'stringLiteral':
            return {
                kind: 'stringLiteral',
                value: ast.value as any,
                sourceLocation: ast.sourceLocation,
            };
        case 'objectLiteral':
            const [typeNameNode, membersNode] = ast.sequenceItems;
            if (isSeparatedListNode(typeNameNode) || isListNode(typeNameNode)) {
                throw debug('todo');
            }
            if (typeNameNode.type != 'typeIdentifier') return 'WrongShapeAst';
            const typeName = typeNameNode.value;
            if (typeof typeName != 'string') return 'WrongShapeAst';
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
            const [accessed, _dot, method, params] = anyAst.sequenceItems;
            const lhsNode = accessed;
            const lhs = astFromParseResult(lhsNode);
            if (lhs == 'WrongShapeAst') {
                return 'WrongShapeAst';
            }
            const memberName = method.value;
            const newParams = params.items.map(astFromParseResult);
            if (newParams == 'WrongShapeAst') {
                return 'WrongShapeAst';
            }
            const r: Ast.PreFunctionExtractionMemberStyleCall = {
                kind: 'memberStyleCall',
                lhs: lhs as Ast.PreFunctionExtractionExpression,
                memberName,
                params: newParams as Ast.PreFunctionExtractionExpression[],
                sourceLocation: ast.sourceLocation,
            };
            return r;
        }
        case 'memberAccess': {
            const anyAst = ast as any;
            const lhsNode = anyAst.sequenceItems[0];
            const lhs = astFromParseResult(lhsNode);
            return {
                kind: 'memberAccess',
                lhs,
                rhs: anyAst.sequenceItems[2].value,
                sourceLocation: ast.sourceLocation,
            } as Ast.PreFunctionExtractionAst;
        }
        case 'concatenation':
            if (!('sequenceItems' in ast))
                throw debug('children not in ast in astFromParseResult');
            return {
                kind: 'concatenation',
                lhs: astFromParseResult(ast.sequenceItems[0]),
                rhs: astFromParseResult(ast.sequenceItems[2]),
                sourceLocation: ast.sourceLocation,
            } as Ast.PreFunctionExtractionAst;
        case 'function': {
            functionId++;
            const [_lb, args, _rb, _arrow, expr] = ast.sequenceItems as any;
            return {
                kind: 'functionLiteral',
                body: [
                    {
                        kind: 'returnStatement',
                        expression: astFromParseResult(expr),
                        sourceLocation: ast.sourceLocation,
                    },
                ],
                parameters: extractParameterList(args),
                sourceLocation: ast.sourceLocation,
            } as Ast.PreFunctionExtractionAst;
        }
        case 'functionWithBlock': {
            functionId++;
            const [_lb, args, _rb, _arrow, body] = ast.sequenceItems;
            const parameters2: Variable[] = extractParameterList(args);
            return {
                kind: 'functionLiteral',
                body: extractFunctionBody(body),
                parameters: parameters2,
                sourceLocation: ast.sourceLocation,
            };
        }
        case 'forLoop': {
            const a = ast as any;
            const [_for, condition, bodyUnex] = a.sequenceItems;
            const body = extractFunctionBody(bodyUnex);
            const [id, _colon, iteratee] = condition.sequenceItems;
            const lst = astFromParseResult(iteratee);
            if (lst == 'WrongShapeAst') return lst;
            const result: Ast.PreFunctionExtractionForLoop = {
                kind: 'forLoop',
                var: id.value,
                list: lst as Ast.PreFunctionExtractionExpression,
                body,
                sourceLocation: a.sourceLocation,
            };
            return result;
        }
        case 'booleanLiteral':
            return {
                kind: 'booleanLiteral',
                value: ast.value == 'true',
                sourceLocation: ast.sourceLocation,
            };
        case 'program':
            const [program] = ast.sequenceItems;
            return {
                kind: 'program',
                statements: extractFunctionBody(program),
                sourceLocation: ast.sourceLocation,
            };
        case 'listLiteral':
            const [items] = ast.sequenceItems;
            if (!isSeparatedListNode(items)) throw debug('todo');
            return {
                kind: 'listLiteral',
                items: items.items.map(
                    astFromParseResult
                ) as Ast.PreFunctionExtractionExpression[],
                sourceLocation: ast.sourceLocation,
            };
        case 'indexAccess':
            const [accessed, index] = ast.sequenceItems;
            return {
                kind: 'indexAccess',
                index: astFromParseResult(index) as Ast.PreFunctionExtractionExpression,
                accessed: astFromParseResult(accessed) as Ast.PreFunctionExtractionExpression,
                sourceLocation: ast.sourceLocation,
            };
        case 'separatedStatement':
            const [statement, _sep] = ast.sequenceItems;
            return astFromParseResult(statement);
        default:
            throw debug(`${ast.type} unhandled in astFromParseResult`);
    }
};

export const divvyIntoFunctions = (
    makeId,
    ast: Ast.PreFunctionExtractionAst
): {
    functions: Map<String, PFAst.ExtractedFunction>;
    updated: PFAst.PostFunctionExtractionAst;
} => {
    const recurse = x => divvyIntoFunctions(makeId, x);
    switch (ast.kind) {
        case 'number':
        case 'identifier':
        case 'booleanLiteral':
        case 'stringLiteral':
            return { functions: new Map(), updated: ast };
        case 'typeDeclaration':
            // TODO: recurse into methods
            return { functions: new Map(), updated: ast };
        case 'reassignment':
        case 'typedDeclarationAssignment':
        case 'declarationAssignment':
        case 'returnStatement': {
            const recursed = recurse(ast.expression);
            return {
                functions: recursed.functions,
                updated: { ...ast, expression: recursed.updated } as any,
            };
        }
        case 'concatenation':
        case 'equality':
        case 'subtraction':
        case 'product':
        case 'addition': {
            const lhsRecurse = recurse(ast.lhs);
            const rhsRecurse = recurse(ast.rhs);
            const extractedFunctions = { ...lhsRecurse.functions, ...rhsRecurse.functions };
            return {
                functions: extractedFunctions,
                updated: { ...ast, lhs: lhsRecurse.updated, rhs: rhsRecurse.updated } as any,
            };
        }
        case 'ternary': {
            const conditionRecursed = recurse(ast.condition);
            const ifTrueRecursed = recurse(ast.ifTrue);
            const ifFalseRecursed = recurse(ast.ifFalse);
            const extractedFunctions = {
                ...conditionRecursed.functions,
                ...ifTrueRecursed.functions,
                ...ifFalseRecursed.functions,
            };
            return {
                functions: extractedFunctions,
                updated: {
                    ...ast,
                    condition: conditionRecursed.updated,
                    ifTrue: ifTrueRecursed.updated,
                    ifFalse: ifFalseRecursed.updated,
                } as any,
            };
        }
        case 'callExpression': {
            const recursed = ast.arguments.map(recurse);
            const extractedFunctions = Object.assign({}, ...recursed.map(r => r.functions));
            return {
                functions: extractedFunctions,
                updated: { ...ast, arguments: recursed.map(r => r.updated).flat() } as any,
            };
        }
        case 'functionLiteral': {
            const recursed = ast.body.map(recurse);
            const extractedFunctions = Object.assign({}, ...recursed.map(r => r.functions));
            const id = `user_${makeId()}`;
            extractedFunctions[id] = {
                sourceLocation: ast.sourceLocation,
                statements: recursed.map(r => r.updated),
                parameters: ast.parameters,
            };
            return {
                functions: extractedFunctions,
                updated: {
                    sourceLocation: ast.sourceLocation,
                    kind: 'functionReference',
                    value: id,
                },
            };
        }
        case 'objectLiteral': {
            const recursed = ast.members.map(m => m.expression).map(recurse);
            const extractedFunctions = Object.assign({}, ...recursed.map(r => r.functions));
            const reassembledMembers = zipWith(ast.members, recursed, (m, r) => ({
                ...m,
                expression: r.updated,
            }));
            return {
                functions: extractedFunctions,
                updated: { ...ast, members: reassembledMembers },
            };
        }
        case 'listLiteral': {
            const recursed = ast.items.map(recurse);
            const extractedFunctions = Object.assign({}, ...recursed.map(r => r.functions));
            return {
                functions: extractedFunctions,
                updated: { ...ast, items: recursed.map(r => r.updated) as any },
            };
        }
        case 'forLoop': {
            const listRecursed = recurse(ast.list);
            const bodyRecursed = ast.body.map(recurse);
            const extractedFunctions = Object.assign(
                {},
                listRecursed.functions,
                ...bodyRecursed.map(r => r.functions)
            );
            return {
                functions: extractedFunctions,
                updated: {
                    ...ast,
                    list: listRecursed.updated,
                    body: bodyRecursed.map(r => r.updated) as any,
                } as any,
            };
        }
        case 'indexAccess': {
            const indexRecursed = recurse(ast.index);
            const accessedRecursed = recurse(ast.accessed);
            const extractedFunctions = {
                ...indexRecursed.functions,
                ...accessedRecursed.functions,
            };
            return {
                functions: extractedFunctions,
                updated: {
                    ...ast,
                    index: indexRecursed.updated,
                    accessed: accessedRecursed.updated,
                } as any,
            };
        }
        case 'memberAccess': {
            const recursed = recurse(ast.lhs);
            return {
                functions: recursed.functions,
                updated: { ...ast, lhs: recursed.updated } as any,
            };
        }
        case 'memberStyleCall': {
            const lhsRecursed = recurse(ast.lhs);
            const paramsRecursed = ast.params.map(recurse);
            const extractedFunctions = Object.assign(
                {},
                lhsRecursed.functions,
                ...paramsRecursed.map(r => r.functions)
            );
            return {
                functions: extractedFunctions,
                updated: {
                    ...ast,
                    lhs: lhsRecursed.updated as any,
                    params: paramsRecursed.map(r => r.updated) as any,
                },
            };
        }
        case 'program': {
            const recursed = ast.statements.map(recurse);
            const mainStatements = recursed.map(r => r.updated).flat();
            const extractedFunctions = Object.assign({}, ...recursed.map(r => r.functions));
            return {
                functions: extractedFunctions,
                updated: { ...ast, statements: mainStatements as any },
            };
        }
    }
};

export const divvyMainIntoFunctions = (
    ast: Ast.PreFunctionExtractionProgram
): Map<String, PFAst.ExtractedFunction> => {
    const { functions, updated } = divvyIntoFunctions(idMaker(), ast);
    if (!('statements' in updated)) {
        throw debug('program in, nonprogram out');
    }
    functions['builtin_main'] = {
        kind: 'functionLiteral',
        statements: updated.statements,
        parameters: [],
        sourceLocation: ast.sourceLocation,
    };
    return functions;
};

// Converts UninferredFunctions in untypedFunctions to variables and adds them to typedVariables and typedFunctions (all arguments excpet 1st modified)
// TODO: Old version only added to functions. Should these be split? Probably?
export const inferFunctions = (
    availableTypes,
    typedVariables: Variable[],
    typedFunctions: Map<String, Function>,
    untypedFunctions: Map<String, PFAst.ExtractedFunction>
): TypeError[] => {
    const waitingToBeTypedFunctions = deepCopy(untypedFunctions);
    let anythingChanged = true;
    const typeErrors: TypeError[] = [];
    while (anythingChanged) {
        anythingChanged = false;
        for (const [name, fn] of Object.entries(waitingToBeTypedFunctions)) {
            const fnObj = functionObjectFromAst(
                {
                    w: fn,
                    availableVariables: typedVariables,
                    availableTypes,
                },
                untypedFunctions
            );
            const inferred = inferFunction(
                {
                    w: fnObj,
                    availableTypes,
                    availableVariables: typedVariables,
                },
                untypedFunctions
            );
            if (Array.isArray(inferred)) {
                // todo: handle type errors here
                throw debug('type errors we arent ready for');
            }
            typedVariables.push({
                name,
                type: FunctionType(inferred.parameters, [], inferred.returnType),
                exported: false,
            });
            typedFunctions.set(name, inferred);
            delete waitingToBeTypedFunctions[name];
            anythingChanged = true;
            typeErrors.push(
                ...typeCheckFunction(
                    {
                        w: fnObj,
                        availableVariables: typedVariables,
                        availableTypes,
                    },
                    untypedFunctions
                ).typeErrors
            );
        }
    }
    if (Object.entries(waitingToBeTypedFunctions).length == 0) {
        return typeErrors;
    } else {
        throw debug('failed to infer a function');
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
    const availableTypes = walkAst<TypeDeclaration, Ast.PreFunctionExtractionTypeDeclaration>(
        ast,
        ['typeDeclaration'],
        n => n
    );

    const untypedFunctions = divvyMainIntoFunctions(ast);
    const typedVariables: Variable[] = [];
    const typedFunctions: Map<string, Function> = new Map();
    const typeErrors = inferFunctions(
        availableTypes,
        [...builtinFunctions, ...typedVariables],
        typedFunctions,
        untypedFunctions
    );
    if (typeErrors.length > 0) {
        return { typeErrors };
    }

    const stringLiteralIdMaker = idMaker();
    const nonUniqueStringLiterals = walkAst<StringLiteralData, Ast.StringLiteral>(
        ast,
        ['stringLiteral'],
        (astNode: Ast.StringLiteral) => ({ id: stringLiteralIdMaker(), value: astNode.value })
    );
    const stringLiterals: StringLiteralData[] = uniqueBy(s => s.value, nonUniqueStringLiterals);

    const main = typedFunctions.get('builtin_main');
    if (!main) {
        throw debug('no main');
    }
    typedFunctions.delete('builtin_main');

    // Add typed functions to typed variables since we inserted calls to those functions
    for (const [name, fn] of typedFunctions.entries()) {
        typedVariables.push({
            name,
            type: getTypeOfFunction(fn),
            exported: false,
        });
    }

    const globalDeclarations: Variable[] = main.statements
        .filter(s => s.kind === 'typedDeclarationAssignment')
        .map(assignment =>
            assignmentToGlobalDeclaration(
                {
                    w: assignment as any,
                    availableVariables: [
                        ...builtinFunctions,
                        ...typedVariables,
                        ...main.variables,
                    ],
                    availableTypes,
                },
                untypedFunctions
            )
        );

    // Get the function literals we gave names to into the declaration
    globalDeclarations.push(...typedVariables);
    return {
        types: availableTypes,
        functions: typedFunctions,
        builtinFunctions,
        program: main,
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
