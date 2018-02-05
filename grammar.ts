import {
    terminal,
    endOfInput,
    Grammar,
    AstNode,
    AstLeaf,
    AstInteriorNode,
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

const plus = terminal<MplAstInteriorNodeType, MplToken>('sum');
const minus = terminal<MplAstInteriorNodeType, MplToken>('subtraction');
const times = terminal<MplAstInteriorNodeType, MplToken>('product');
const leftBracket = terminal<MplAstInteriorNodeType, MplToken>('leftBracket');
const rightBracket = terminal<MplAstInteriorNodeType, MplToken>('rightBracket');
const int = terminal<MplAstInteriorNodeType, MplToken>('number');
const identifier = terminal<MplAstInteriorNodeType, MplToken>('identifier');
const colon = terminal<MplAstInteriorNodeType, MplToken>('colon');
const ternaryOperator = terminal<MplAstInteriorNodeType, MplToken>('ternaryOperator');
const type = terminal<MplAstInteriorNodeType, MplToken>('type');
const assignment = terminal<MplAstInteriorNodeType, MplToken>('assignment');
const _return = terminal<MplAstInteriorNodeType, MplToken>('return');
const statementSeparator = terminal<MplAstInteriorNodeType, MplToken>('statementSeparator');
const fatArrow = terminal<MplAstInteriorNodeType, MplToken>('fatArrow');
const leftCurlyBrace = terminal<MplAstInteriorNodeType, MplToken>('leftCurlyBrace');
const rightCurlyBrace = terminal<MplAstInteriorNodeType, MplToken>('rightCurlyBrace');
const comma = terminal<MplAstInteriorNodeType, MplToken>('comma');
const concatenation = terminal<MplAstInteriorNodeType, MplToken>('concatenation');
const equality = terminal<MplAstInteriorNodeType, MplToken>('equality');
const boolean = terminal<MplAstInteriorNodeType, MplToken>('booleanLiteral');
const stringLiteral = terminal<MplAstInteriorNodeType, MplToken>('stringLiteral');

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

export type MplAstInteriorNodeType =
    | 'program'
    | 'function'
    | 'functionWithBlock'
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

export type MplAstNode = AstNode<MplAstInteriorNodeType, MplToken>;
export type MplAstInteriorNode = AstInteriorNode<MplAstInteriorNodeType, MplToken>;
export type MplParseResult = ParseResult<MplAstInteriorNodeType, MplToken>;

export const grammar: Grammar<MplAstInteriorNodeType, MplToken> = {
    program: { n: 'program', p: ['functionBody', endOfInput] },
    function: [
        { n: 'function', p: ['argList', fatArrow, 'expression'] },
        {
            n: 'functionWithBlock',
            p: ['argList', fatArrow, leftCurlyBrace, 'functionBody', rightCurlyBrace],
        },
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
