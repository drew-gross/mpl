const { alternative, sequence, terminal } = require('./parser-combinator.js');

const parseProgram = (t, i) => parseProgramI(t, i);
const parseStatement = (t, i) => parseStatementI(t, i);
const parseFunction = (t, i) => parseFunctionI(t, i);
const parseArgList = (t, i) => parseArgListI(t, i);
const parseParamList = (t, i) => parseParamListI(t, i);
const parseExpression = (t, i) => parseExpressionI(t, i);
const parseSubtraction = (t, i) => parseSubtractionI(t, i);
const parseProduct = (t, i) => parseProductI(t, i);
const parseSimpleExpression = (t, i) => parseSimpleExpressionI(t, i);

// Grammar:
// PROGRAM -> STATEMENT STATEMENT_SEPARATOR PROGRAM | return EXPRESSION
// STATEMENT -> identifier = FUNCTION
// FUNCTION -> ARG_LIST => EXPRESSION
// ARG_LIST -> identifier , ARG_LIST | identifier
// PARAM_LIST -> EXPRESSION , PARAM_LIST | EXPRESSION
// EXPRESSION -> SUBTRACTION;
// SUBTRACTION -> PRODUCT - EXPRESSION | PRODUCT
// PRODUCT -> SIMPLE_EXPRESSION * PRODUCT | SIMPLE_EXPRESSION | ( EXPRESSION )
// SIMPLE_EXPRESSION -> identifier ( ARG_LIST ) | int | identifier

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
    parseSubtraction,
]);

const parseSubtractionI = alternative([
    sequence('subtraction1', [parseProduct, terminal('subtraction'), parseExpression]),
    parseProduct,
]);

const parseProductI = alternative([
    sequence('product1', [parseSimpleExpression, terminal('product'), parseProduct]),
    parseSimpleExpression,
    sequence('product2', [terminal('leftBracket'), parseExpression, terminal('rightBracket')]),
]);

const parseSimpleExpressionI = alternative([
    sequence('callExpression', [
        terminal('identifier'),
        terminal('leftBracket'),
        parseParamList,
        terminal('rightBracket'),
    ]),
    terminal('number'), terminal('identifier')
]);

module.exports = parseProgram;
