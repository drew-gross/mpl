const { alternative, sequence, terminal } = require('./parser-combinator.js');

const parseProgram = (t, i) => parseProgramI(t, i);
const parseStatement = (t, i) => parseStatementI(t, i);
const parseFunction = (t, i) => parseFunctionI(t, i);
const parseArgList = (t, i) => parseArgListI(t, i);
const parseExpression = (t, i) => parseExpressionI(t, i);
const parseCallExpression = (t, i) => parseCallExpressionI(t, i);
const parseProduct = (t, i) => parseProductI(t, i);
const parseSubtraction = (t, i) => parseSubtractionI(t, i);

// Grammar:
// PROGRAM -> STATEMENT STATEMENT_SEPARATOR PROGRAM | return EXPRESSION
// STATEMENT -> identifier = FUNCTION
// FUNCTION -> ARG_LIST => EXPRESSION
// ARG_LIST -> EXPRESSION , ARG_LIST | EXPRESSION
// EXPRESSION -> SUBTRACTION | CALL_EXPRESSION | int | identifier;
// CALL_EXPRESSION -> identifier ( ARG_LIST )
// SUBTRACTION -> PRODUCT - EXPRESSION | PRODUCT
// PRODUCT -> int * PRODUCT | int | ( EXPRESSION )

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
    sequence('argList', [parseExpression, terminal('comma'), parseArgList]),
    parseExpression,
]);

const parseExpressionI = alternative([
    parseSubtraction,
    parseCallExpression,
    terminal('number'),
    terminal('identifier'),
]);

const parseCallExpressionI = sequence('callExpression', [
    terminal('identifier'),
    terminal('leftBracket'),
    parseArgList,
    terminal('rightBracket'),
]);

const parseSubtractionI = alternative([
    sequence('subtraction1', [parseProduct, terminal('subtraction'), parseExpression]),
    parseProduct,
]);

const parseProductI = alternative([
    sequence('product3', [terminal('number'), terminal('product'), parseProduct]),
    terminal('number'),
    sequence('product2', [terminal('leftBracket'), parseExpression, terminal('rightBracket')]),
]);


module.exports = parseProgram;
