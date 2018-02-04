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

const tokenToLeafNode = (token: MplToken): MplAstLeafNodeType => {
    switch (token) {
        case 'number':
            return 'number';
        case 'booleanLiteral':
            return 'booleanLiteral';
        case 'identifier':
            return 'identifier';
        case 'type':
            return 'type';
        case 'stringLiteral':
            return 'stringLiteral';
        case 'return':
        case 'statementSeparator':
        case 'fatArrow':
        case 'equality':
        case 'assignment':
        case 'sum':
        case 'product':
        case 'subtraction':
        case 'leftBracket':
        case 'rightBracket':
        case 'leftCurlyBrace':
        case 'rightCurlyBrace':
        case 'colon':
        case 'comma':
        case 'ternaryOperator':
        case 'endOfFile':
        case 'concatenation':
        case 'invalid':
        default:
            throw debug();
    }
};

const plus: BaseParser<MplAstInteriorNodeType, MplAstLeafNodeType, MplToken> = terminal(tokenToLeafNode, 'sum');
const minus: BaseParser<MplAstInteriorNodeType, MplAstLeafNodeType, MplToken> = terminal(
    tokenToLeafNode,
    'subtraction'
);
const times: BaseParser<MplAstInteriorNodeType, MplAstLeafNodeType, MplToken> = terminal(tokenToLeafNode, 'product');
const leftBracket: BaseParser<MplAstInteriorNodeType, MplAstLeafNodeType, MplToken> = terminal(
    tokenToLeafNode,
    'leftBracket'
);
const rightBracket: BaseParser<MplAstInteriorNodeType, MplAstLeafNodeType, MplToken> = terminal(
    tokenToLeafNode,
    'rightBracket'
);
const int: BaseParser<MplAstInteriorNodeType, MplAstLeafNodeType, MplToken> = terminal(tokenToLeafNode, 'number');
const identifier: BaseParser<MplAstInteriorNodeType, MplAstLeafNodeType, MplToken> = terminal(
    tokenToLeafNode,
    'identifier'
);
const colon: BaseParser<MplAstInteriorNodeType, MplAstLeafNodeType, MplToken> = terminal(tokenToLeafNode, 'colon');
const ternaryOperator: BaseParser<MplAstInteriorNodeType, MplAstLeafNodeType, MplToken> = terminal(
    tokenToLeafNode,
    'ternaryOperator'
);
const type: BaseParser<MplAstInteriorNodeType, MplAstLeafNodeType, MplToken> = terminal(tokenToLeafNode, 'type');
const assignment: BaseParser<MplAstInteriorNodeType, MplAstLeafNodeType, MplToken> = terminal(
    tokenToLeafNode,
    'assignment'
);
const _return: BaseParser<MplAstInteriorNodeType, MplAstLeafNodeType, MplToken> = terminal(tokenToLeafNode, 'return');
const statementSeparator: BaseParser<MplAstInteriorNodeType, MplAstLeafNodeType, MplToken> = terminal(
    tokenToLeafNode,
    'statementSeparator'
);
const fatArrow: BaseParser<MplAstInteriorNodeType, MplAstLeafNodeType, MplToken> = terminal(
    tokenToLeafNode,
    'fatArrow'
);
const leftCurlyBrace: BaseParser<MplAstInteriorNodeType, MplAstLeafNodeType, MplToken> = terminal(
    tokenToLeafNode,
    'leftCurlyBrace'
);
const rightCurlyBrace: BaseParser<MplAstInteriorNodeType, MplAstLeafNodeType, MplToken> = terminal(
    tokenToLeafNode,
    'rightCurlyBrace'
);
const comma: BaseParser<MplAstInteriorNodeType, MplAstLeafNodeType, MplToken> = terminal(tokenToLeafNode, 'comma');
const concatenation: BaseParser<MplAstInteriorNodeType, MplAstLeafNodeType, MplToken> = terminal(
    tokenToLeafNode,
    'concatenation'
);
const equality: BaseParser<MplAstInteriorNodeType, MplAstLeafNodeType, MplToken> = terminal(
    tokenToLeafNode,
    'equality'
);
const boolean: BaseParser<MplAstInteriorNodeType, MplAstLeafNodeType, MplToken> = terminal(
    tokenToLeafNode,
    'booleanLiteral'
);
const stringLiteral: BaseParser<MplAstInteriorNodeType, MplAstLeafNodeType, MplToken> = terminal(
    tokenToLeafNode,
    'stringLiteral'
);

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
    | 'addition1'
    | 'subtraction1'
    | 'product1'
    | 'equality'
    | 'concatenation'
    | 'bracketedExpression'
    | 'callExpression'
    | 'paramList';

export type MplAstLeafNodeType = 'number' | 'booleanLiteral' | 'identifier' | 'type' | 'stringLiteral';

export type MplAstNode = AstNode<MplAstInteriorNodeType, MplAstLeafNodeType>;
export type MplAstLeafNode = AstLeaf<MplAstLeafNodeType>;
export type MplAstInteriorNode = AstInteriorNode<MplAstInteriorNodeType, MplAstLeafNodeType>;
export type MplParseResult = ParseResult<MplAstInteriorNodeType, MplAstLeafNodeType, MplToken>;

export const grammar: Grammar<MplAstInteriorNodeType, MplAstLeafNodeType, MplToken> = {
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
    addition: [{ n: 'addition1', p: ['subtraction', plus, 'addition'] }, 'subtraction'],
    subtraction: [{ n: 'subtraction1', p: ['product', minus, 'subtraction'] }, 'product'],
    product: [{ n: 'product1', p: ['equality', times, 'product'] }, 'equality'],
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
