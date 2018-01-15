import { TokenType, Token } from './lex.js';
import { alternative, sequence, terminal, endOfInput, ParseResult, AstNodeType } from './parser-combinator.js';
import debug from './util/debug.js';

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

type BaseParser = (tokens: Token[], index: number) => ParseResult;
type SequenceParser = { n: string, p: (string | BaseParser)[] };
type AlternativeParser = (SequenceParser | string | BaseParser)[];

type Parser = {
    [index: string]: SequenceParser | AlternativeParser,
}

const isSequence = (val: SequenceParser | AlternativeParser): val is SequenceParser =>  {
    return 'n' in val;
}

const plus = terminal('sum');
const minus = terminal('subtraction');
const leftBracket = terminal('leftBracket');
const rightBracket = terminal('rightBracket');
const int = terminal('number');
const _return = terminal('return');

export const parse = (parser: Parser, currentParser: string, tokens: Token[]): ParseResult => {
    const index = 0;
    const childrenParser = parser[currentParser];
    if (typeof childrenParser === 'string') {
        // Base Parser
        const children = parse(childrenParser, currentParser, tokens);
    } else if (isSequence(childrenParser)) {
        // Sequence Parser
        for (const p of childrenParser.p) {
            if (typeof p === 'function') {
                const result: ParseResult = p(tokens, index);
                if (result.success == false) {
                    break;
                }
            } else {
                debug();
            }
        }
    } else {
        debug();
    }

    return {
        type: currentParser as AstNodeType,
        children: [],
        success: true,
        newIndex: 0,
    };
};

export const parser: Parser = {
    program: { n: 'progam', p: [_return, 'expression', endOfInput] },
    expression: { n: 'addition1', p: ['addition'] },
    addition: [
        { n: 'subtraction1', p: ['subtraction', plus, 'expression'] },
        'subtraction',
    ],
    subtraction: [
        { n: 'subtraction1', p: ['simpleExpression', minus, 'subtraction'] },
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
