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

const plus: BaseParser<MplAstInteriorNodeType, MplToken> = terminal<MplAstInteriorNodeType, MplToken>('sum');
const minus: BaseParser<MplAstInteriorNodeType, MplToken> = terminal<MplAstInteriorNodeType, MplToken>('subtraction');
const times: BaseParser<MplAstInteriorNodeType, MplToken> = terminal<MplAstInteriorNodeType, MplToken>('product');
const leftBracket: BaseParser<MplAstInteriorNodeType, MplToken> = terminal<MplAstInteriorNodeType, MplToken>(
    'leftBracket'
);
const rightBracket: BaseParser<MplAstInteriorNodeType, MplToken> = terminal<MplAstInteriorNodeType, MplToken>(
    'rightBracket'
);
const int: BaseParser<MplAstInteriorNodeType, MplToken> = terminal<MplAstInteriorNodeType, MplToken>('number');
const identifier: BaseParser<MplAstInteriorNodeType, MplToken> = terminal<MplAstInteriorNodeType, MplToken>(
    'identifier'
);
const colon: BaseParser<MplAstInteriorNodeType, MplToken> = terminal<MplAstInteriorNodeType, MplToken>('colon');
const ternaryOperator: BaseParser<MplAstInteriorNodeType, MplToken> = terminal<MplAstInteriorNodeType, MplToken>(
    'ternaryOperator'
);
const type: BaseParser<MplAstInteriorNodeType, MplToken> = terminal<MplAstInteriorNodeType, MplToken>('type');
const assignment: BaseParser<MplAstInteriorNodeType, MplToken> = terminal<MplAstInteriorNodeType, MplToken>(
    'assignment'
);
const _return: BaseParser<MplAstInteriorNodeType, MplToken> = terminal<MplAstInteriorNodeType, MplToken>('return');
const statementSeparator: BaseParser<MplAstInteriorNodeType, MplToken> = terminal<MplAstInteriorNodeType, MplToken>(
    'statementSeparator'
);
const fatArrow: BaseParser<MplAstInteriorNodeType, MplToken> = terminal<MplAstInteriorNodeType, MplToken>('fatArrow');
const leftCurlyBrace: BaseParser<MplAstInteriorNodeType, MplToken> = terminal<MplAstInteriorNodeType, MplToken>(
    'leftCurlyBrace'
);
const rightCurlyBrace: BaseParser<MplAstInteriorNodeType, MplToken> = terminal<MplAstInteriorNodeType, MplToken>(
    'rightCurlyBrace'
);
const comma: BaseParser<MplAstInteriorNodeType, MplToken> = terminal<MplAstInteriorNodeType, MplToken>('comma');
const concatenation: BaseParser<MplAstInteriorNodeType, MplToken> = terminal<MplAstInteriorNodeType, MplToken>(
    'concatenation'
);
const equality: BaseParser<MplAstInteriorNodeType, MplToken> = terminal<MplAstInteriorNodeType, MplToken>('equality');
const boolean: BaseParser<MplAstInteriorNodeType, MplToken> = terminal<MplAstInteriorNodeType, MplToken>(
    'booleanLiteral'
);
const stringLiteral: BaseParser<MplAstInteriorNodeType, MplToken> = terminal<MplAstInteriorNodeType, MplToken>(
    'stringLiteral'
);

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
