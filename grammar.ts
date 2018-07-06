import {
    terminal,
    endOfInput,
    Grammar,
    Ast,
    Leaf as AstLeaf,
    ParseResult,
    Sequence,
    OneOf,
} from './parser-combinator.js';
import { TokenSpec } from './lex.js';
import debug from './util/debug.js';

export type MplToken =
    | 'return'
    | 'booleanLiteral'
    | 'stringLiteral'
    | 'identifier'
    | 'typeIdentifier'
    | 'statementSeparator'
    | 'fatArrow'
    | 'thinArrow'
    | 'equality'
    | 'assignment'
    | 'number'
    | 'sum'
    | 'product'
    | 'subtraction'
    | 'leftBracket'
    | 'rightBracket'
    | 'leftCurlyBrace'
    | 'rightCurlyBrace'
    | 'colon'
    | 'comma'
    | 'ternaryOperator'
    | 'endOfFile'
    | 'concatenation'
    | 'lessThan'
    | 'greaterThan'
    | 'invalid';

const plus = terminal<MplAstNode, MplToken>('sum');
const minus = terminal<MplAstNode, MplToken>('subtraction');
const times = terminal<MplAstNode, MplToken>('product');
const leftBracket = terminal<MplAstNode, MplToken>('leftBracket');
const rightBracket = terminal<MplAstNode, MplToken>('rightBracket');
const int = terminal<MplAstNode, MplToken>('number');
const identifier = terminal<MplAstNode, MplToken>('identifier');
const colon = terminal<MplAstNode, MplToken>('colon');
const ternaryOperator = terminal<MplAstNode, MplToken>('ternaryOperator');
const typeIdentifier = terminal<MplAstNode, MplToken>('typeIdentifier');
const assignment = terminal<MplAstNode, MplToken>('assignment');
const _return = terminal<MplAstNode, MplToken>('return');
const statementSeparator = terminal<MplAstNode, MplToken>('statementSeparator');
const fatArrow = terminal<MplAstNode, MplToken>('fatArrow');
const thinArrow = terminal<MplAstNode, MplToken>('thinArrow');
const leftCurlyBrace = terminal<MplAstNode, MplToken>('leftCurlyBrace');
const rightCurlyBrace = terminal<MplAstNode, MplToken>('rightCurlyBrace');
const comma = terminal<MplAstNode, MplToken>('comma');
const concatenation = terminal<MplAstNode, MplToken>('concatenation');
const equality = terminal<MplAstNode, MplToken>('equality');
const boolean = terminal<MplAstNode, MplToken>('booleanLiteral');
const stringLiteral = terminal<MplAstNode, MplToken>('stringLiteral');
const lessThan = terminal<MplAstNode, MplToken>('lessThan');
const greaterThan = terminal<MplAstNode, MplToken>('greaterThan');

export const tokenSpecs: TokenSpec<MplToken>[] = [
    {
        token: '"[^"]*"',
        type: 'stringLiteral',
        action: x => {
            const trimmed = x.trim();
            const quotesRemoved = trimmed.substring(1, trimmed.length - 1);
            return quotesRemoved;
        },
        toString: x => x,
    },
    {
        token: ',',
        type: 'comma',
        toString: () => ', ',
    },
    {
        token: 'return',
        type: 'return',
        toString: () => 'return',
    },
    {
        token: 'true|false',
        type: 'booleanLiteral',
        action: x => x.trim(),
        toString: x => x,
    },
    {
        token: '[a-z]\\w*',
        type: 'identifier',
        action: x => x,
        toString: x => x,
    },
    {
        token: '[A-Z][a-z]*',
        type: 'typeIdentifier',
        action: x => x,
        toString: x => x,
    },
    {
        token: ';',
        type: 'statementSeparator',
        toString: _ => ';',
    },
    {
        token: '=>',
        type: 'fatArrow',
        toString: _ => '=>',
    },
    {
        token: '->',
        type: 'thinArrow',
        toString: _ => '->',
    },
    {
        token: '==',
        type: 'equality',
        toString: _ => '==',
    },
    {
        token: '=',
        type: 'assignment',
        toString: _ => '=',
    },
    {
        token: '\\d+',
        type: 'number',
        action: parseInt,
        toString: x => x.toString(),
    },
    {
        token: '\\+\\+',
        type: 'concatenation',
        toString: _ => '++',
    },
    {
        token: '\\+',
        type: 'sum',
        toString: _ => '+',
    },
    {
        token: '\\*',
        type: 'product',
        toString: _ => '*',
    },
    {
        token: '\\-',
        type: 'subtraction',
        toString: _ => '-',
    },
    {
        token: '\\(',
        type: 'leftBracket',
        toString: _ => '(',
    },
    {
        token: '\\)',
        type: 'rightBracket',
        toString: _ => ')',
    },
    {
        token: '{',
        type: 'leftCurlyBrace',
        toString: _ => '{',
    },
    {
        token: '}',
        type: 'rightCurlyBrace',
        toString: _ => '}',
    },
    {
        token: '\\:',
        type: 'colon',
        toString: _ => ':',
    },
    {
        token: '\\?',
        type: 'ternaryOperator',
        toString: _ => '?',
    },
    {
        token: '<',
        type: 'lessThan',
        toString: _ => '<',
    },
    {
        token: '>',
        type: 'greaterThan',
        toString: _ => '>',
    },
    {
        token: '.*',
        type: 'invalid',
        action: x => x,
        toString: x => x,
    },
];

export type MplAstNode =
    | 'program'
    | 'function'
    | 'functionWithBlock'
    | 'bracketedArgList'
    | 'argList'
    | 'arg'
    | 'statement'
    | 'returnStatement'
    | 'typedDeclarationAssignment'
    | 'declarationAssignment'
    | 'reassignment'
    | 'ternary'
    | 'addition'
    | 'subtraction'
    | 'product'
    | 'equality'
    | 'concatenation'
    | 'bracketedExpression'
    // TOOD: unify these.
    | 'callExpression'
    | 'callExpressionNoArgs'
    | 'typeWithArgs'
    | 'typeWithoutArgs'
    | 'typeList'
    | 'paramList';

export type MplAst = Ast<MplAstNode, MplToken>;
export type MplParseResult = ParseResult<MplAstNode, MplToken>;

export const grammar: Grammar<MplAstNode, MplToken> = {
    program: Sequence<MplAstNode, MplToken>('program', ['functionBody', endOfInput]),
    function: OneOf([
        Sequence<MplAstNode, MplToken>('function', ['argList', fatArrow, 'expression']),
        Sequence<MplAstNode, MplToken>('functionWithBlock', [
            'argList',
            fatArrow,
            leftCurlyBrace,
            'functionBody',
            rightCurlyBrace,
        ]),
    ]),
    bracketedArgList: OneOf([
        Sequence('bracketedArgList', [leftBracket, rightBracket]),
        Sequence('bracketedArgList', [leftBracket, 'argList', rightBracket]),
    ]),
    argList: OneOf([Sequence('argList', ['arg', comma, 'argList']), 'bracketedArgList', 'arg']),
    arg: Sequence('arg', [identifier, colon, 'type']),
    functionBody: OneOf([
        Sequence('statement', ['statement', statementSeparator, 'functionBody']),
        Sequence('returnStatement', [_return, 'expression', statementSeparator]),
        Sequence('returnStatement', [_return, 'expression']),
    ]),
    statement: OneOf([
        Sequence('typedDeclarationAssignment', [identifier, colon, 'type', assignment, 'expression']),
        Sequence('declarationAssignment', [identifier, colon, assignment, 'expression']),
        Sequence('reassignment', [identifier, assignment, 'expression']),
    ]),
    typeList: OneOf([Sequence('typeList', ['type', comma, 'typeList']), 'type']),
    type: OneOf([
        Sequence('typeWithArgs', [typeIdentifier, lessThan, 'typeList', greaterThan]),
        Sequence('typeWithoutArgs', [typeIdentifier]),
    ]),
    expression: 'ternary',
    ternary: OneOf([Sequence('ternary', ['addition', ternaryOperator, 'addition', colon, 'addition']), 'addition']),
    addition: OneOf([Sequence('addition', ['subtraction', plus, 'addition']), 'subtraction']),
    subtraction: OneOf([Sequence('subtraction', ['product', minus, 'subtraction']), 'product']),
    product: OneOf([Sequence('product', ['equality', times, 'product']), 'equality']),
    equality: OneOf([Sequence('equality', ['concatenation', equality, 'equality']), 'concatenation']),
    concatenation: OneOf([
        Sequence('concatenation', ['simpleExpression', concatenation, 'concatenation']),
        'simpleExpression',
    ]),
    simpleExpression: OneOf([
        Sequence('bracketedExpression', [leftBracket, 'expression', rightBracket]),
        Sequence('callExpressionNoArgs', [identifier, leftBracket, rightBracket]),
        Sequence('callExpression', [identifier, leftBracket, 'paramList', rightBracket]),
        int,
        boolean,
        stringLiteral,
        'function',
        identifier,
    ]),
    paramList: OneOf([Sequence('paramList', ['expression', comma, 'paramList']), 'expression']),
};
