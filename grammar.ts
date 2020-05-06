import {
    Terminal,
    Grammar,
    Ast,
    ParseResult,
    Sequence,
    SeparatedList,
    OneOf,
    Optional,
    Many,
} from './parser-lib/parse';
import { TokenSpec } from './parser-lib/lex';

export type MplToken =
    | 'return'
    | 'export'
    | 'booleanLiteral'
    | 'stringLiteral'
    | 'identifier'
    | 'typeIdentifier'
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
    | 'leftSquareBracket'
    | 'rightSquareBracket'
    | 'colon'
    | 'comma'
    | 'ternaryOperator'
    | 'concatenation'
    | 'lessThan'
    | 'greaterThan'
    | 'memberAccess';

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
    { token: ',', type: 'comma', toString: () => ', ' },
    // TODO: Make a "keyword" utility function for the lexer. Also figure out why \b doesn't work here.
    { token: 'return[^A-z]', type: 'return', toString: () => 'return' },
    { token: 'export[^A-z]', type: 'export', toString: () => 'export' },
    { token: 'true|false', type: 'booleanLiteral', action: x => x.trim(), toString: x => x },
    { token: '[a-z]\\w*', type: 'identifier', action: x => x, toString: x => x },
    { token: '[A-Z][A-Za-z]*', type: 'typeIdentifier', action: x => x, toString: x => x },
    { token: ';', type: 'statementSeparator', toString: _ => ';' },
    { token: '=>', type: 'fatArrow', toString: _ => '=>' },
    { token: '==', type: 'equality', toString: _ => '==' },
    { token: '=', type: 'assignment', toString: _ => '=' },
    { token: '\\d+', type: 'number', action: parseInt, toString: x => x.toString() },
    { token: '\\+\\+', type: 'concatenation', toString: _ => '++' },
    { token: '\\+', type: 'sum', toString: _ => '+' },
    { token: '\\*', type: 'product', toString: _ => '*' },
    { token: '\\-', type: 'subtraction', toString: _ => '-' },
    { token: '\\(', type: 'leftBracket', toString: _ => '(' },
    { token: '\\)', type: 'rightBracket', toString: _ => ')' },
    { token: '{', type: 'leftCurlyBrace', toString: _ => '{' },
    { token: '}', type: 'rightCurlyBrace', toString: _ => '}' },
    { token: '\\[', type: 'leftSquareBracket', toString: _ => '[' },
    { token: '\\]', type: 'rightSquareBracket', toString: _ => ']' },
    { token: '\\:', type: 'colon', toString: _ => ':' },
    { token: '\\?', type: 'ternaryOperator', toString: _ => '?' },
    { token: '<', type: 'lessThan', toString: _ => '<' },
    { token: '>', type: 'greaterThan', toString: _ => '>' },
    { token: '\\.', type: 'memberAccess', toString: _ => '.' },
];

export type MplAstNode =
    | 'program'
    | 'function'
    | 'functionWithBlock'
    | 'argList'
    | 'arg'
    | 'statement'
    | 'returnStatement'
    | 'declaration'
    | 'reassignment'
    | 'ternary'
    | 'addition'
    | 'subtraction'
    | 'product'
    | 'equality'
    | 'concatenation'
    | 'bracketedExpression'
    | 'callExpression'
    | 'typeDeclaration'
    | 'typeWithArgs'
    | 'typeWithoutArgs'
    | 'listType'
    | 'typeLiteral'
    | 'typeLiteralComponent'
    | 'typeList'
    | 'objectLiteral'
    | 'objectLiteralComponent'
    | 'memberAccess'
    | 'memberStyleCall'
    | 'listLiteral'
    | 'listItems'
    | 'indexAccess'
    | 'paramList';

export type MplAst = Ast<MplAstNode, MplToken>;
export type MplParseResult = ParseResult<MplAstNode, MplToken>;

const mplTerminal = token => Terminal<MplAstNode, MplToken>(token);
const mplOptional = parser => Optional<MplAstNode, MplToken>(parser);

const export_ = mplTerminal('export');
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
const leftCurlyBrace = mplTerminal('leftCurlyBrace');
const rightCurlyBrace = mplTerminal('rightCurlyBrace');
const leftSquareBracket = mplTerminal('leftSquareBracket');
const rightSquareBracket = mplTerminal('rightSquareBracket');
const comma = mplTerminal('comma');
const concatenation = mplTerminal('concatenation');
const equality = mplTerminal('equality');
const boolean = mplTerminal('booleanLiteral');
const stringLiteral = mplTerminal('stringLiteral');
const lessThan = mplTerminal('lessThan');
const greaterThan = mplTerminal('greaterThan');
const memberAccess = mplTerminal('memberAccess');

const curlies = { left: leftCurlyBrace, right: rightCurlyBrace };

export const grammar: Grammar<MplAstNode, MplToken> = {
    program: Sequence<MplAstNode, MplToken>('program', ['functionBody']),
    function: OneOf([
        Sequence('function', [
            mplOptional(leftBracket),
            'argList', // TODO pull out "args" into separate rule
            mplOptional(rightBracket),
            fatArrow,
            'expression',
        ]),
        Sequence('functionWithBlock', [
            mplOptional(leftBracket),
            'argList',
            mplOptional(rightBracket),
            fatArrow,
            leftCurlyBrace,
            'functionBody',
            rightCurlyBrace,
        ]),
    ]),
    argList: SeparatedList(comma, 'arg'),
    arg: Sequence('arg', [identifier, colon, 'type']),
    functionBody: Sequence('statement', [
        'statement',
        statementSeparator,
        mplOptional('functionBody'),
    ]),
    statement: OneOf([
        Sequence('declaration', [
            mplOptional(export_),
            identifier,
            colon,
            mplOptional('type'),
            assignment,
            'expression',
        ]),
        Sequence('typeDeclaration', [typeIdentifier, colon, assignment, 'type']),
        Sequence('reassignment', [identifier, assignment, 'expression']),
        Sequence('returnStatement', [_return, 'expression']),
    ]),
    typeList: SeparatedList(comma, 'type'),
    type: OneOf([
        Sequence('listType', [typeIdentifier, leftSquareBracket, rightSquareBracket]),
        Sequence('typeWithArgs', [typeIdentifier, lessThan, 'typeList', greaterThan]),
        Sequence('typeWithoutArgs', [typeIdentifier]),
        'typeLiteral',
    ]),
    typeLiteral: Sequence('typeLiteral', [
        leftCurlyBrace,
        Many('typeLiteralComponent'),
        rightCurlyBrace,
    ]),
    typeLiteralComponent: Sequence('typeLiteralComponent', [
        identifier,
        colon,
        'type',
        statementSeparator,
    ]),
    objectLiteral: Sequence('objectLiteral', [
        typeIdentifier,
        Many('objectLiteralComponent', { nestedIn: curlies }),
    ]),
    objectLiteralComponent: Sequence('objectLiteralComponent', [
        identifier,
        colon,
        'expression',
        comma,
    ]),
    expression: 'ternary',
    ternary: OneOf([
        Sequence('ternary', ['addition', ternaryOperator, 'addition', colon, 'addition']),
        'addition',
    ]),
    addition: OneOf([Sequence('addition', ['subtraction', plus, 'addition']), 'subtraction']),
    subtraction: OneOf([Sequence('subtraction', ['product', minus, 'subtraction']), 'product']),
    product: OneOf([Sequence('product', ['equality', times, 'product']), 'equality']),
    equality: OneOf([
        Sequence('equality', ['concatenation', equality, 'equality']),
        'concatenation',
    ]),
    concatenation: OneOf([
        Sequence('concatenation', ['memberAccess', concatenation, 'concatenation']),
        'memberStyleCall',
    ]),
    memberStyleCall: OneOf([
        Sequence('memberStyleCall', [
            'simpleExpression',
            memberAccess,
            identifier,
            leftBracket,
            'paramList',
            rightBracket,
        ]),
        'memberAccess',
    ]),
    memberAccess: OneOf([
        Sequence('memberAccess', ['simpleExpression', memberAccess, identifier]),
        'indexAccess',
    ]),
    indexAccess: OneOf([
        Sequence('indexAccess', [
            'simpleExpression',
            leftSquareBracket,
            'simpleExpression',
            rightSquareBracket,
        ]),
        'listLiteral',
    ]),
    listLiteral: OneOf([
        Sequence('listLiteral', [leftSquareBracket, 'listItems', rightSquareBracket]),
        'simpleExpression',
    ]),
    listItems: SeparatedList(comma, 'expression'),
    simpleExpression: OneOf([
        Sequence('bracketedExpression', [leftBracket, 'expression', rightBracket]),
        Sequence('callExpression', [
            identifier,
            leftBracket,
            mplOptional('paramList'),
            rightBracket,
        ]),
        int,
        boolean,
        stringLiteral,
        'function',
        'objectLiteral',
        identifier,
    ]),
    paramList: SeparatedList(comma, 'expression'),
};
