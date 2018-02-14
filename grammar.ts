import {
    terminal,
    endOfInput,
    Grammar,
    Ast,
    Leaf as AstLeaf,
    ParseResult,
    SequenceParser,
    BaseParser,
} from './parser-combinator.js';
import { TokenSpec } from './lex.js';
import debug from './util/debug.js';

export type MplToken =
    | 'return'
    | 'booleanLiteral'
    | 'stringLiteral'
    | 'identifier'
    | 'type'
    | 'statementSeparator'
    | 'fatArrow'
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
const type = terminal<MplAstNode, MplToken>('type');
const assignment = terminal<MplAstNode, MplToken>('assignment');
const _return = terminal<MplAstNode, MplToken>('return');
const statementSeparator = terminal<MplAstNode, MplToken>('statementSeparator');
const fatArrow = terminal<MplAstNode, MplToken>('fatArrow');
const leftCurlyBrace = terminal<MplAstNode, MplToken>('leftCurlyBrace');
const rightCurlyBrace = terminal<MplAstNode, MplToken>('rightCurlyBrace');
const comma = terminal<MplAstNode, MplToken>('comma');
const concatenation = terminal<MplAstNode, MplToken>('concatenation');
const equality = terminal<MplAstNode, MplToken>('equality');
const boolean = terminal<MplAstNode, MplToken>('booleanLiteral');
const stringLiteral = terminal<MplAstNode, MplToken>('stringLiteral');

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
        type: 'type',
        action: x => x,
        toString: x => x,
    },
    {
        token: ';',
        type: 'statementSeparator',
        toString: _ => ';\n',
    },
    {
        token: '=>',
        type: 'fatArrow',
        toString: _ => '=>',
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
    | 'typedAssignment'
    | 'assignment'
    | 'ternary'
    | 'addition'
    | 'subtraction'
    | 'product'
    | 'equality'
    | 'concatenation'
    | 'bracketedExpression'
    | 'callExpression'
    | 'paramList';

export type MplAst = Ast<MplAstNode, MplToken>;
export type MplParseResult = ParseResult<MplAstNode, MplToken>;

export const grammar: Grammar<MplAstNode, MplToken> = {
    program: { n: 'program', p: ['functionBody', endOfInput] },
    function: [
        { n: 'function', p: ['argList', fatArrow, 'expression'] },
        {
            n: 'functionWithBlock',
            p: ['argList', fatArrow, leftCurlyBrace, 'functionBody', rightCurlyBrace],
        },
    ],
    bracketedArgList: [
        { n: 'bracketedArgList', p: [leftBracket, rightBracket] },
        { n: 'bracketedArgList', p: [leftBracket, 'argList', rightBracket] },
    ],
    argList: [{ n: 'argList', p: ['arg', comma, 'argList'] }, 'arg'],
    arg: { n: 'arg', p: [identifier, colon, type] },
    functionBody: [
        { n: 'statement', p: ['statement', statementSeparator, 'functionBody'] },
        { n: 'returnStatement', p: [_return, 'expression', statementSeparator] },
        { n: 'returnStatement', p: [_return, 'expression'] },
    ],
    statement: [
        { n: 'typedAssignment', p: [identifier, colon, type, assignment, 'expression'] },
        { n: 'assignment', p: [identifier, assignment, 'expression'] },
    ],
    expression: ['ternary'],
    ternary: [{ n: 'ternary', p: ['addition', ternaryOperator, 'addition', colon, 'addition'] }, 'addition'],
    addition: [{ n: 'addition', p: ['subtraction', plus, 'addition'] }, 'subtraction'],
    subtraction: [{ n: 'subtraction', p: ['product', minus, 'subtraction'] }, 'product'],
    product: [{ n: 'product', p: ['equality', times, 'product'] }, 'equality'],
    equality: [{ n: 'equality', p: ['concatenation', equality, 'equality'] }, 'concatenation'],
    concatenation: [
        { n: 'concatenation', p: ['simpleExpression', concatenation, 'concatenation'] },
        'simpleExpression',
    ],
    simpleExpression: [
        { n: 'bracketedExpression', p: [leftBracket, 'expression', rightBracket] },
        { n: 'callExpression', p: [identifier, leftBracket, 'paramList', rightBracket] },
        int,
        boolean,
        stringLiteral,
        'function',
        identifier,
    ],
    paramList: [{ n: 'paramList', p: ['expression', comma, 'paramList'] }, 'expression'],
};
