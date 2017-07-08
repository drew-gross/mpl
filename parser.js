const { alternative, sequence, terminal } = require('./parser-combinator.js');

const parseProgram = (t, i) => parseProgramI(t, i);
const parseStatement = (t, i) => parseStatementI(t, i);
const parseFunction = (t, i) => parseFunctionI(t, i);
const parseArgList = (t, i) => parseArgListI(t, i);
const parseParamList = (t, i) => parseParamListI(t, i);
const parseExpression = (t, i) => parseExpressionI(t, i);
const parseCallExpression = (t, i) => parseCallExpressionI(t, i);
const parseSubtraction = (t, i) => parseSubtractionI(t, i);
const parseProduct = (t, i) => parseProductI(t, i);
const parseLiteral = (t, i) => parseLiteralI(t, i);

// Grammar:
// PROGRAM -> STATEMENT STATEMENT_SEPARATOR PROGRAM | return EXPRESSION
// STATEMENT -> identifier = FUNCTION
// FUNCTION -> ARG_LIST => EXPRESSION
// ARG_LIST -> identifier , ARG_LIST | identifier
// PARAM_LIST -> EXPRESSION , PARAM_LIST | EXPRESSION
// EXPRESSION -> CALL_EXPRESSION | SUBTRACTION | int | identifier;
// CALL_EXPRESSION -> identifier ( ARG_LIST )
// SUBTRACTION -> PRODUCT - EXPRESSION | PRODUCT
// PRODUCT -> LITERAL * PRODUCT | LITERAL | CALL_EXPRESSION * PRODUCT | CALL_EXPRESSION | ( EXPRESSION )
// LITERAL -> int | identifier

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

const parseParamListI = alternative([
    sequence('paramList', [parseExpression, terminal('comma'), parseParamList]),
    parseExpression,
]);

const parseExpressionI = alternative([
    parseCallExpression,
    parseSubtraction,
    terminal('number'),
    terminal('identifier'),
]);

const parseCallExpressionI = sequence('callExpression', [
    terminal('identifier'),
    terminal('leftBracket'),
    parseParamList,
    terminal('rightBracket'),
]);

const parseSubtractionI = alternative([
    sequence('subtraction1', [parseProduct, terminal('subtraction'), parseExpression]),
    parseProduct,
]);

const parseProductI = alternative([
    sequence('product1', [parseLiteral, terminal('product'), parseProduct]),
    parseLiteral,
    sequence('product1', [parseCallExpression, terminal('product'), parseProduct]),
    parseCallExpression,
    sequence('product2', [terminal('leftBracket'), parseExpression, terminal('rightBracket')]),
]);

const parseLiteralI = alternative([terminal('number'), terminal('identifier')]);

module.exports = parseProgram;
