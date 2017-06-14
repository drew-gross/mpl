const { alternative, sequence, terminal } = require('./parser-combinator.js');

const parseProgram = (t, i) => parseProgramI(t, i);
const parseStatement = (t, i) => parseStatementI(t, i);
const parseFunction = (t, i) => parseFunctionI(t, i);
const parseArgList = (t, i) => parseArgListI(t, i);
const parseExpression = (t, i) => parseExpressionI(t, i);
const parseCallExpression = (t, i) => parseCallExpressionI(t, i);
const parseProduct = (t, i) => parseProductI(t, i);

// Grammar:
// PROGRAM -> STATEMENT STATEMENT_SEPARATOR PROGRAM | return EXPRESSION
// STATEMENT -> identifier = FUNCTION
// FUNCTION -> ARG_LIST => EXPRESSION
// ARG_LIST -> identifier, ARG_LIST | identifier
// EXPRESSION -> PRODUCT | ( EXPRESSION ) | CALL_EXPRESSION | int
// CALL_EXPRESSION -> identifier ( ARG_LIST )
// PRODUCT -> int * EXPRESSION | ( EXPRESSION ) * EXPRESSION | CALL_EXPRESSION * EXPRESSION

const parseProgramI = alternative([
    sequence('statement', [parseStatement, terminal('statementSeparator'), parseProgram]),
    sequence('returnStatement', [terminal('return'), parseExpression]),
]);

const parseStatementI = sequence('assignment', [
    terminal('identifier'),
    terminal('assignment'),
    parseFunction,
]);

const parseFunctionI = sequence('function', [parseArgList, terminal('fatArrow'), parseExpression]);

const parseArgListI = alternative([
    sequence('argList', [terminal('identifier'), terminal('comma'), parseArgList]),
    terminal('identifier'),
]);

const parseExpression2 = sequence('bracketedExpression', [
    terminal('leftBracket'),
    parseExpression,
    terminal('rightBracket'),
]);
const parseExpressionI = alternative([
    parseProduct,
    parseExpression2,
    parseCallExpression,
    terminal('number')
]);

const parseCallExpressionI = sequence('callExpression', [
    terminal('identifier'),
    terminal('leftBracket'),
    parseArgList,
    terminal('rightBracket'),
]);

const parseProduct1 = sequence('product1', [
    terminal('number'),
    terminal('product'),
    parseExpression,
]);
const parseProduct2 = sequence('product2', [
    terminal('leftBracket'),
    parseExpression,
    terminal('rightBracket'),
    terminal('product'),
    parseExpression,
]);
const parseProduct3 = sequence('product3', [
    parseCallExpression,
    terminal('product'),
    parseExpression,
]);
const parseProductI = alternative([parseProduct1, parseProduct2, parseProduct3]);

module.exports = parseProgram;
