import { TokenType } from './lex.js';
import { alternative, sequence, terminal, endOfInput, ParseResult } from './parser-combinator.js';

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
// EXPRESSION -> TERNARY | SUBTRACTION;
// TERNARY -> SUBTRACTION ? SUBTRACTION : SUBTRACTION;
// SUBTRACTION -> PRODUCT - EXPRESSION | PRODUCT
// PRODUCT -> EQUALITY * PRODUCT | EQUALITY
// EQUALITY -> CONCATENATION == EQUALITY | CONCATENATION
// CONCATENATION -> SIMPLE_EXPRESSION ++ CONCATENATION | SIMPLE_EXPRESSION
// SIMPLE_EXPRESSION -> ( EXPRESSION ) | identifier ( PARAM_LIST ) | int | boolean | string | FUNCTION | identifier

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

const ternaryI = sequence('ternary', [
    subtraction,
    terminal('ternaryOperator'),
    subtraction,
    terminal('colon'),
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
