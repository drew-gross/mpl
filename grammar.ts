import {
    terminal,
    endOfInput,
    Grammar,
    Ast,
    Leaf as AstLeaf,
    ParseResult,
    Sequence,
    OneOf,
    Optional,
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
    | 'memberAccess'
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
        token: '.',
        type: 'memberAccess',
        toString: _ => '.',
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
    | 'callExpression'
    | 'typeWithArgs'
    | 'typeWithoutArgs'
    | 'typeList'
    | 'paramList';

export type MplAst = Ast<MplAstNode, MplToken>;
export type MplParseResult = ParseResult<MplAstNode, MplToken>;

const mplTerminal = token => terminal<MplAstNode, MplToken>(token);
const mplOptional = parser => Optional<MplAstNode, MplToken>(parser);

const plus = mplTerminal('sum');
const minus = mplTerminal('subtraction');
const times = mplTerminal('product');
const leftBracket = mplTerminal('leftBracket');
const rightBracket = mplTerminal('rightBracket');
const int = mplTerminal('number');
const identifier = mplTerminal('identifier');
const colon = mplTerminal('colon');
const ternaryOperator = mplTerminal('ternaryOperator');
const typeIdentifier = mplTerminal('typeIdentifier');
const assignment = mplTerminal('assignment');
const _return = mplTerminal('return');
const statementSeparator = mplTerminal('statementSeparator');
const fatArrow = mplTerminal('fatArrow');
const thinArrow = mplTerminal('thinArrow');
const leftCurlyBrace = mplTerminal('leftCurlyBrace');
const rightCurlyBrace = mplTerminal('rightCurlyBrace');
const comma = mplTerminal('comma');
const concatenation = mplTerminal('concatenation');
const equality = mplTerminal('equality');
const boolean = mplTerminal('booleanLiteral');
const stringLiteral = mplTerminal('stringLiteral');
const lessThan = mplTerminal('lessThan');
const greaterThan = mplTerminal('greaterThan');

export const grammar: Grammar<MplAstNode, MplToken> = {
    program: Sequence<MplAstNode, MplToken>('program', ['functionBody', endOfInput]),
    function: OneOf([
        Sequence('function', ['argList', fatArrow, 'expression']),
        Sequence('functionWithBlock', ['argList', fatArrow, leftCurlyBrace, 'functionBody', rightCurlyBrace]),
    ]),
    bracketedArgList: OneOf([Sequence('bracketedArgList', [leftBracket, mplOptional('argList'), rightBracket])]),
    argList: OneOf([Sequence('argList', ['arg', comma, 'argList']), 'bracketedArgList', 'arg']),
    arg: Sequence('arg', [identifier, colon, 'type']),
    functionBody: OneOf([
        Sequence('statement', ['statement', statementSeparator, 'functionBody']),
        Sequence('returnStatement', [_return, 'expression', Optional(statementSeparator)]),
    ]),
    statement: OneOf([
        Sequence('typedDeclarationAssignment', [identifier, colon, 'type', assignment, 'expression']),
        Sequence('declarationAssignment', [identifier, colon, assignment, 'expression']),
        //Sequence('typeDeclaration', [typeIdentifier, colon, assignment, leftCurlyBrace, rightCurlyBrace]),
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
        Sequence('callExpression', [identifier, leftBracket, mplOptional('paramList'), rightBracket]),
        int,
        boolean,
        stringLiteral,
        'function',
        identifier,
    ]),
    paramList: OneOf([Sequence('paramList', ['expression', comma, 'paramList']), 'expression']),
};
