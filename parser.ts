import { TokenType, Token } from './lex.js';
import {
    alternative,
    sequence,
    terminal,
    endOfInput,
    ParseResult,
    ParseResultWithIndex,
    ParseError,
    AstNodeType,
    AstNode,
    AstNodeWithIndex,
    parseResultIsError
} from './parser-combinator.js';
import debug from './util/debug.js';
import unique from './util/list/unique.js';
import flatten from './util/list/flatten.js';

const program = (t, i) => programI(t, i);
const functionBody = (t, i) => functionBodyI(t, i);
const statement = (t, i) => statementI(t, i);
const func = (t, i) => funcI(t, i);
const argList = (t, i) => argListI(t, i);
const arg = (t, i) => argI(t, i);
const paramList = (t, i) => paramListI(t, i);
const expression = (t, i) => expressionI(t, i);
const ternary = (t, i) => ternaryI(t, i);
const subtraction = (t, i) => subtractionI(t, i);
const addition = (t, i) => additionI(t, i);
const product = (t, i) => productI(t, i);
const equality = (t, i) => equalityI(t, i);
const simpleExpression = (t, i) => simpleExpressionI(t, i);
const concatenation = (t, i) => concatenationI(t, i);

// Grammar:
// PROGRAM -> FUNCTION_BODY end_of_input
// FUNCTION -> ARG_LIST => EXPRESSION | ARG_LIST => { FUNCTION_BODY }
// FUNCTION_BODY -> STATEMENT STATEMENT_SEPARATOR FUNCTION_BODY | return EXPRESSION STATEMENT_SEPARATOR | return EXPRESSION
// STATEMENT -> identifier : type = EXPRESSION | identifier = EXPRESSION
// ARG_LIST -> ARG , ARG_LIST | ARG
// ARG -> identifier : type
// PARAM_LIST -> EXPRESSION , PARAM_LIST | EXPRESSION
// EXPRESSION -> TERNARY
// TERNARY -> ADDITION ? ADDITION : ADDITION | ADDITION
// ADDITION -> SUBTRACTION + EXPRESSION | SUBTRACTION
// SUBTRACTION -> PRODUCT - EXPRESSION | PRODUCT
// PRODUCT -> EQUALITY * PRODUCT | EQUALITY
// EQUALITY -> CONCATENATION == EQUALITY | CONCATENATION
// CONCATENATION -> SIMPLE_EXPRESSION ++ CONCATENATION | SIMPLE_EXPRESSION
// SIMPLE_EXPRESSION -> ( EXPRESSION ) | identifier ( PARAM_LIST ) | int | boolean | string | FUNCTION | identifier

type BaseParser = (tokens: Token[], index: number) => ParseResultWithIndex;
type SequenceParser = { n: string, p: (string | BaseParser)[] };
type AlternativeParser = (SequenceParser | string | BaseParser)[];

type Grammar = {
    [index: string]: SequenceParser | AlternativeParser,
}

const isSequence = (val: SequenceParser | AlternativeParser): val is SequenceParser =>  {
    return 'n' in val;
}

const parseSequence = (
    grammar: Grammar,
    parser: SequenceParser,
    tokens: Token[],
    index: number
): ParseResultWithIndex => {
    const results: AstNodeWithIndex[] = [];
    for (const p of parser.p) {
        let result: ParseResultWithIndex;
        if (typeof p === 'function') {
            result = p(tokens, index);
        } else {
            result = parse(grammar, p, tokens, index);
        }

        if (parseResultIsError(result)) {
            return result;
        }

        results.push(result);
        index = result.newIndex as number;
    }

    return {
        success: true,
        newIndex: index,
        type: parser.n as AstNodeType,
        children: results,
    };
};

const parseAlternative = (
    grammar: Grammar,
    alternatives: AlternativeParser,
    tokens: Token[],
    index: number
): ParseResultWithIndex => {
    const errors: ParseError[] = [];
    for (const parser of alternatives) {
        let result;
        if (typeof parser === 'string') {
            result = parse(grammar, parser, tokens, index);
        } else if (typeof parser === 'function') {
            result = parser(tokens, index);
        } else {
            result = parseSequence(grammar, parser, tokens, index);
        }
        if (result.success) {
            return result;
        } else {
            errors.push(result.error);
        }
    }
    return {
        found: unique(errors.map(e => e.found)).join('/'),
        expected: unique(flatten(errors.map(e => e.expected))),
    };
};

export const parse = (grammar: Grammar, firstRule: string, tokens: Token[], index: number): ParseResultWithIndex => {
    const childrenParser = grammar[firstRule];
    if (typeof childrenParser === 'string') {
        return parse(childrenParser, firstRule, tokens, index);
    } else if (isSequence(childrenParser)) {
        return parseSequence(grammar, childrenParser, tokens, index);
    } else if (Array.isArray(childrenParser)) {
        return parseAlternative(grammar, childrenParser, tokens, index);
    } else {
        throw debug();
    }
};

const plus = terminal('sum');
const minus = terminal('subtraction');
const times = terminal('product');
const leftBracket = terminal('leftBracket');
const rightBracket = terminal('rightBracket');
const int = terminal('number');
const _return = terminal('return');

export const grammar: Grammar = {
    program: { n: 'program', p: ['functionBody', endOfInput] },
    functionBody: [
        { n: 'returnStatement', p: [_return, 'expression'] }
    ],
    expression: ['addition'],
    addition: [
        { n: 'addition1', p: ['subtraction', plus, 'expression'] },
        'subtraction',
    ],
    subtraction: [
        { n: 'subtraction1', p: ['product', minus, 'subtraction'] },
        'product',
    ],
    product: [
        { n: 'product', p: ['simpleExpression', times, 'product'] },
        'simpleExpression',
    ],
    simpleExpression: [
        { n: 'bracketedExpression', p: [leftBracket, 'expression', rightBracket] },
        int,
    ],
};

const programI = sequence('program', [functionBody, endOfInput]);

const functionBodyI = alternative([
    sequence('statement', [statement, terminal('statementSeparator'), functionBody]),
    sequence('returnStatement', [terminal('return'), expression, terminal('statementSeparator')]),
    sequence('returnStatement', [terminal('return'), expression]),
]);

const statementI = alternative([
    sequence('typedAssignment', [
        terminal('identifier'),
        terminal('colon'),
        terminal('type'),
        terminal('assignment'),
        expression,
    ]),
    sequence('assignment', [
        terminal('identifier'),
        terminal('assignment'),
        expression,
    ]),
]);

const funcI = alternative([
    sequence('function', [argList, terminal('fatArrow'), expression]),
    sequence('functionWithBlock', [
        argList,
        terminal('fatArrow'),
        terminal('leftCurlyBrace'),
        functionBody,
        terminal('rightCurlyBrace'),
    ]),
]);

const argListI = alternative([
    sequence('argList', [arg, terminal('comma'), argList]),
    arg,
]);

const argI = sequence('arg', [terminal('identifier'), terminal('colon'), terminal('type')]);

const paramListI = alternative([
    sequence('paramList', [expression, terminal('comma'), paramList]),
    expression,
]);

const expressionI = alternative([ternary, subtraction]);

const ternaryI = alternative([
    sequence('ternary', [
        addition,
        terminal('ternaryOperator'),
        addition,
        terminal('colon'),
        addition,
    ]),
    addition,
]);

const additionI = alternative([
    sequence('addition1', [subtraction, terminal('sum'), expression]),
    subtraction,
]);

const subtractionI = alternative([
    sequence('subtraction1', [product, terminal('subtraction'), expression]),
    product,
]);

const productI = alternative([
    sequence('product1', [equality, terminal('product'), product]),
    equality,
]);

const equalityI = alternative([
    sequence('equality', [concatenation, terminal('equality'), equality]),
    concatenation,
]);

const concatenationI = alternative([
    sequence('concatenation', [simpleExpression, terminal('concatenation'), concatenation]),
    simpleExpression,
]);

const simpleExpressionI = alternative([
    sequence('bracketedExpression', [terminal('leftBracket'), expression, terminal('rightBracket')]),
    sequence('callExpression', [terminal('identifier'), terminal('leftBracket'), paramList, terminal('rightBracket')]),
    terminal('number'),
    terminal('booleanLiteral'),
    terminal('stringLiteral'),
    func,
    terminal('identifier'),
]);

export default program;
