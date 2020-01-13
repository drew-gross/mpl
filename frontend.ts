import flatten from './util/list/flatten.js';
import uniqueBy from './util/list/uniqueBy.js';
import idMaker from './util/idMaker.js';
import last from './util/list/last.js';
import debug from './util/debug.js';
import { lex, Token, LexError } from './parser-lib/lex.js';
import { tokenSpecs, grammar, MplAst, MplParseResult, MplToken } from './grammar.js';
import {
    parseResultIsError,
    parse,
    stripResultIndexes,
    isSepearatedListNode,
    isListNode,
} from './parser-lib/parse.js';
import ParseError from './parser-lib/ParseError.js';
import {
    Type,
    ProductComponent,
    equal as typesAreEqual,
    resolve as resolveType,
    builtinTypes,
    builtinFunctions,
    TypeDeclaration,
} from './types.js';
import {
    VariableDeclaration,
    Function,
    UninferredFunction,
    FrontendOutput,
    StringLiteralData,
} from './api.js';
import { TypeError } from './TypeError.js';
import SourceLocation from './parser-lib/sourceLocation.js';
import * as Ast from './ast.js';

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
    if (isSepearatedListNode(ast)) {
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
        case 'typedDeclarationAssignment':
            // Recursive functions can refer to the left side on the right side, so to extract
            // the left side, we need to know about the right side. Probably, this just shouldn't return
            // a type. TODO: allow more types of recursive functions than just single int...
            return {
                name: ctx.w.destination,
                type: (typeOfExpression({ ...ctx, w: ctx.w.expression }) as TOEResult).type,
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
        default:
            throw debug(`${(ast as any).kind} unhandled in walkAst`);
    }
};

const removeBracketsFromAst = ast =>
    transformAst('bracketedExpression', node => node.children[1], ast, true);

const parseMpl = (tokens: Token<MplToken>[]): MplAst | ParseError[] => {
    const parseResult: MplParseResult = stripResultIndexes(parse(grammar, 'program', tokens));

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
    ctx: WithContext<Ast.UninferredExpression>
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
            if (!typesAreEqual(lt.type, builtinTypes.Integer, availableTypes)) {
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
            if (!typesAreEqual(rt.type, builtinTypes.Integer, availableTypes)) {
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
            if (!typesAreEqual(lt.type, rt.type, availableTypes)) {
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
            if (lt.type.kind !== 'String') {
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
            if (rt.type.kind !== 'String') {
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
                    kind: 'Function',
                    arguments: ast.parameters.map(p => p.type),
                    permissions: [],
                    returnType: f.returnType,
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
            if (functionType.kind !== 'Function') {
                return [
                    {
                        kind: 'calledNonFunction',
                        identifierName: functionName,
                        actualType: functionType,
                        sourceLocation: ast.sourceLocation,
                    },
                ];
            }
            if (argTypes.length !== functionType.arguments.length) {
                return [
                    {
                        kind: 'wrongNumberOfArguments',
                        targetFunction: functionName,
                        passedArgumentCount: argTypes.length,
                        expectedArgumentCount: functionType.arguments.length,
                        sourceLocation: ast.sourceLocation,
                    },
                ];
            }
            for (let i = 0; i < argTypes.length; i++) {
                if (
                    !typesAreEqual(
                        (argTypes[i] as TOEResult).type,
                        functionType.arguments[i],
                        availableTypes
                    )
                ) {
                    return [
                        {
                            kind: 'wrongArgumentType',
                            targetFunction: functionName,
                            passedType: (argTypes[i] as TOEResult).type,
                            expectedType: functionType.arguments[i],
                            sourceLocation: ast.sourceLocation,
                        } as TypeError,
                    ];
                }
            }
            return { type: functionType.returnType, extractedFunctions: [] };
        }
        case 'identifier': {
            const declaration = availableVariables.find(({ name }) => ast.value == name);
            if (!declaration) {
                return [
                    {
                        kind: 'unknownTypeForIdentifier',
                        identifierName: ast.value,
                        sourceLocation: ast.sourceLocation,
                    },
                ];
            }
            return { type: declaration.type, extractedFunctions: [] };
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
            if (!typesAreEqual(conditionType.type, builtinTypes.Boolean, availableTypes)) {
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
            if (!typesAreEqual(trueBranchType.type, falseBranchType.type, availableTypes)) {
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
                    kind: 'Product',
                    name: ast.typeName,
                    members: ast.members.map(({ name, expression }) => ({
                        name,
                        type: (recurse(expression) as TOEResult).type,
                    })),
                },
                extractedFunctions: [], // TODO: propagate these
            };
        case 'memberAccess':
            const lhsType = recurse(ast.lhs);
            if (isTypeError(lhsType)) {
                return lhsType;
            }
            let resolvedLhs = lhsType.type;
            if (resolvedLhs.kind == 'NameRef') {
                const resolved = resolveType(resolvedLhs, availableTypes);
                if (!resolved) {
                    return [
                        {
                            kind: 'couldNotFindType',
                            name: resolvedLhs.namedType,
                            sourceLocation: ast.sourceLocation,
                        },
                    ];
                }
                resolvedLhs = resolved;
            }
            if (resolvedLhs.kind != 'Product') {
                return [
                    {
                        kind: 'invalidMemberAccess',
                        found: lhsType.type,
                        sourceLocation: ast.sourceLocation,
                    },
                ];
            }
            const accessedMember = resolvedLhs.members.find(m => m.name == ast.rhs);
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
                } else if (!typesAreEqual(innerType, result.type, availableTypes)) {
                    return [{ kind: 'nonhomogenousList', sourceLocation: ast.sourceLocation }];
                }
                extractedFunctions.push(...result.extractedFunctions);
            }
            if (!innerType) {
                return [{ kind: 'nonhomogenousList', sourceLocation: ast.sourceLocation }]; // TODO infer from target
            }
            return { type: { kind: 'List', of: innerType }, extractedFunctions };
        case 'indexAccess':
            const accessedType = recurse(ast.accessed);
            if (isTypeError(accessedType)) {
                return accessedType;
            }
            if (accessedType.type.kind != 'List') {
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
            if (indexType.type.kind != 'Integer') {
                return [
                    {
                        kind: 'nonIntegerIndex',
                        index: indexType.type,
                        sourceLocation: ast.sourceLocation,
                    },
                ];
            }
            return {
                type: accessedType.type.of,
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
                            kind: 'Function',
                            arguments: [{ kind: 'Integer' }],
                            permissions: [],
                            returnType: { kind: 'Integer' },
                        },
                    },
                ]),
            });
            if (isTypeError(rightType)) {
                return { errors: rightType, newVariables: [] };
            }
            // Left type is inferred as right type
            return {
                errors: [],
                newVariables: [{ name: ast.destination, type: rightType.type }],
            };
        }
        case 'reassignment': {
            const rightType = typeOfExpression({ ...ctx, w: ast.expression });
            if (isTypeError(rightType)) {
                return { errors: rightType, newVariables: [] };
            }
            const leftType = availableVariables.find(v => v.name == ast.destination);
            if (!leftType) {
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
            if (!typesAreEqual(leftType.type, rightType.type, availableTypes)) {
                return {
                    errors: [
                        {
                            kind: 'assignWrongType',
                            lhsName: ast.destination,
                            lhsType: leftType.type,
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
            const expressionType = typeOfExpression({
                ...ctx,
                w: ast.expression,
                availableVariables: mergeDeclarations(availableVariables, [
                    { name: ast.destination, type: destinationType },
                ]),
            });
            if (isTypeError(expressionType)) {
                return { errors: expressionType, newVariables: [] };
            }
            if (!typesAreEqual(expressionType.type, destinationType, availableTypes)) {
                return {
                    errors: [
                        {
                            kind: 'assignWrongType',
                            lhsName: ast.destination,
                            lhsType: destinationType,
                            rhsType: expressionType.type,
                            sourceLocation: ast.sourceLocation,
                        },
                    ],
                    newVariables: [],
                };
            }
            return {
                errors: [],
                newVariables: [{ name: ast.destination, type: destinationType }],
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
): VariableDeclaration => {
    const result = typeOfExpression({ ...ctx, w: ctx.w.expression });
    if (isTypeError(result)) throw debug('isTypeError in assignmentToGlobalDeclaration');
    return { name: ctx.w.destination, type: result.type };
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
    if (!maybeReturnStatement || maybeReturnStatement.kind != 'returnStatement') {
        throw debug('Missing returnStatement');
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
            return {
                kind: 'typedDeclarationAssignment',
                sourceLocation: ast.sourceLocation,
                expression: recurse(ast.expression),
                type: ast.type,
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
                type: { kind: 'List', of: itemType },
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

const extractFunctionBody = node => {
    switch (node.type) {
        case 'returnStatement':
            return [astFromParseResult(node)];
        case 'statement':
            return [
                astFromParseResult(node.children[0]),
                ...extractFunctionBody(node.children[2]),
            ];
        default:
            throw debug(`${node.type} unhandled in extractFunctionBody`);
    }
};

// TODO: Replace extractParameterList with SeparatedList
const extractParameterList = (ast: MplAst): VariableDeclaration[] => {
    if (isSepearatedListNode(ast)) {
        return flatten(
            ast.items.map(i => {
                if (isSepearatedListNode(i) || !('children' in i)) {
                    throw debug('todo');
                }
                const child2 = i.children[2];
                if (isSepearatedListNode(child2) || isListNode(child2)) {
                    throw debug('todo');
                }
                if (child2.type == 'typeWithoutArgs') {
                    return [
                        {
                            name: (i.children[0] as any).value as string,
                            type: parseType(child2),
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
    if (isSepearatedListNode(ast) || isListNode(ast)) {
        throw debug('todo');
    }
    if (ast.type != 'typeLiteralComponent') throw debug('wrong as type');
    return {
        name: (ast.children[0] as any).value,
        type: parseType(ast.children[2]),
    };
};

const parseType = (ast: MplAst): Type => {
    if (isSepearatedListNode(ast) || isListNode(ast)) {
        throw debug('todo');
    }
    switch (ast.type) {
        case 'typeWithArgs': {
            const name = (ast.children[0] as any).value;
            if (name != 'Function') throw debug('Only functions support args right now');
            const list = ast.children[2];
            if (!isSepearatedListNode(list)) throw debug('todo');
            const typeList = list.items.map(parseType);
            return {
                kind: name,
                arguments: typeList.slice(0, typeList.length - 1),
                returnType: typeList[typeList.length - 1],
            };
        }
        case 'typeWithoutArgs': {
            const node = ast.children[0];
            if (isSepearatedListNode(node) || isListNode(node)) {
                throw debug('todo');
            }
            if (node.type != 'typeIdentifier') throw debug('Failed to parse type');
            const name = node.value;
            if (typeof name != 'string') throw debug('Failed to parse type');
            switch (name) {
                case 'String':
                case 'Integer':
                case 'Boolean':
                    return { kind: name } as Type;
                default:
                    return { kind: 'NameRef', namedType: name };
            }
        }
        case 'typeLiteral':
            return {
                kind: 'Product',
                name: ast.type,
                members: (ast.children[1] as any).children.map(parseTypeLiteralComponent),
            };
        default:
            throw debug(`${ast.type} unhandled in parseType`);
    }
};

const parseObjectMember = (ast: MplAst): Ast.UninferredObjectMember | 'WrongShapeAst' => {
    if (isSepearatedListNode(ast) || isListNode(ast)) {
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

let functionId = 0;
const astFromParseResult = (ast: MplAst): Ast.UninferredAst | 'WrongShapeAst' => {
    if (isSepearatedListNode(ast) || isListNode(ast)) {
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
            if (!isSepearatedListNode(child2)) {
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
        case 'declarationAssignment':
            if (!('children' in ast)) throw debug('children not in ast in astFromParseResult');
            return {
                kind: 'declarationAssignment',
                destination: (ast.children[0] as any).value as any,
                expression: astFromParseResult(ast.children[3]),
                sourceLocation: ast.sourceLocation,
            } as Ast.UninferredAst;
        case 'typedDeclarationAssignment':
            const destinationNode = ast.children[0];
            if (isSepearatedListNode(destinationNode) || isListNode(destinationNode)) {
                throw debug('todo');
            }
            if (destinationNode.type != 'identifier') return 'WrongShapeAst';
            const expression = astFromParseResult(ast.children[4]); // TODO: figure out why this isn't a type error
            return {
                kind: 'typedDeclarationAssignment',
                destination: destinationNode.value,
                type: parseType(ast.children[2]),
                expression,
                sourceLocation: ast.sourceLocation,
            } as Ast.UninferredAst;
        case 'typeDeclaration':
            const type: Type = parseType(ast.children[3]);
            const name: string = (ast.children[0] as any).value;
            if (type.kind == 'Product') {
                type.name = name;
            }
            return {
                kind: 'typeDeclaration',
                name,
                type,
                sourceLocation: ast.sourceLocation,
            } as Ast.UninferredTypeDeclaration & SourceLocation;
        case 'stringLiteral':
            return {
                kind: 'stringLiteral',
                value: ast.value as any,
                sourceLocation: ast.sourceLocation,
            };
        case 'objectLiteral':
            const typeNameNode = ast.children[0];
            if (isSepearatedListNode(typeNameNode) || isListNode(typeNameNode)) {
                throw debug('todo');
            }
            if (typeNameNode.type != 'typeIdentifier') return 'WrongShapeAst';
            const typeName = typeNameNode.value;
            if (typeof typeName != 'string') return 'WrongShapeAst';
            const membersNode = ast.children[2];
            if (isSepearatedListNode(membersNode) || isListNode(membersNode)) {
                throw debug('todo');
            }
            if (membersNode.type != 'objectLiteralComponents') return 'WrongShapeAst';
            const members = membersNode.children.map(parseObjectMember);
            if (members.some(m => m == 'WrongShapeAst')) return 'WrongShapeAst';
            return {
                kind: 'objectLiteral',
                typeName,
                members: members as any,
                sourceLocation: ast.sourceLocation,
            };
        case 'memberAccess':
            const anyAst = ast as any;
            const lhsNode = anyAst.children[0];
            const lhs = astFromParseResult(lhsNode);
            return {
                kind: 'memberAccess',
                lhs,
                rhs: anyAst.children[2].value,
                sourceLocation: ast.sourceLocation,
            } as Ast.UninferredAst;
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
                statements: makeProgramAstNodeFromStatmentParseResult(ast.children[0]),
                sourceLocation: ast.sourceLocation,
            };
        case 'listLiteral':
            const items = ast.children[1];
            if (!isSepearatedListNode(items)) throw debug('todo');
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

    const availableTypes = walkAst<TypeDeclaration, Ast.UninferredTypeDeclaration>(
        ast,
        ['typeDeclaration'],
        n => n
    );

    let availableVariables = builtinFunctions;
    const program: UninferredFunction = {
        name: `main_program`,
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

    const globalDeclarations: VariableDeclaration[] = program.statements
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

    const inferredProgram = inferFunction({ w: program, availableVariables, availableTypes });
    if (isTypeError(inferredProgram)) {
        return { typeErrors: inferredProgram };
    }

    if (!typesAreEqual(inferredProgram.returnType, builtinTypes.Integer, availableTypes)) {
        return {
            typeErrors: [
                {
                    kind: 'wrongTypeReturn',
                    expressionType: inferredProgram.returnType,
                    sourceLocation: { line: 1, column: 1 },
                },
            ],
        };
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
