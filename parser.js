const { alternative, sequence, terminal } = require('./parser-combinator.js');

const parseProgram = (t, i) => parseProgramI(t, i);
const parseStatement = (t, i) => parseStatementI(t, i);
const parseFunction = (t, i) => parseFunctionI(t, i);
const parseArgList = (t, i) => parseArgListI(t, i);
const parseArg = (t, i) => parseArgI(t, i);
const parseParamList = (t, i) => parseParamListI(t, i);
const parseExpression = (t, i) => parseExpressionI(t, i);
const parseTernary = (t, i) => parseTernaryI(t, i);
const parseSubtraction = (t, i) => parseSubtractionI(t, i);
const parseProduct = (t, i) => parseProductI(t, i);
const parseEquality = (t, i) => parseEqualityI(t, i);
const parseSimpleExpression = (t, i) => parseSimpleExpressionI(t, i);

// Grammar:
// PROGRAM -> STATEMENT STATEMENT_SEPARATOR PROGRAM | return EXPRESSION
// STATEMENT -> identifier : type = EXPRESSION | identifier = EXPRESSION
// FUNCTION -> ARG_LIST => EXPRESSION
// ARG_LIST -> ARG , ARG_LIST | ARG
// ARG -> identifier : type
// PARAM_LIST -> EXPRESSION , PARAM_LIST | EXPRESSION
// EXPRESSION -> TERNARY | SUBTRACTION;
// TERNARY -> SUBTRACTION ? SUBTRACTION : SUBTRACTION;
// SUBTRACTION -> PRODUCT - EXPRESSION | PRODUCT
// PRODUCT -> EQUALITY * PRODUCT | EQUALITY
// EQUALITY -> SIMPLE_EXPRESSION == EQUALITY | SIMPLE_EXPRESSION
// SIMPLE_EXPRESSION -> ( EXPRESSION ) | identifier ( ARG_LIST ) | int | boolean | identifier | FUNCTION

const parseProgramI = alternative([
    sequence('statement', [parseStatement, terminal('statementSeparator'), parseProgram]),
    sequence('returnStatement', [terminal('return'), parseExpression]),
]);

const parseStatementI = alternative([
    sequence('typedAssignment', [
        terminal('identifier'),
        terminal('colon'),
        terminal('type'),
        terminal('assignment'),
        parseExpression,
    ]),
    sequence('assignment', [
        terminal('identifier'),
        terminal('assignment'),
        parseExpression,
    ]),
]);

const parseFunctionI = sequence('function', [parseArgList, terminal('fatArrow'), parseExpression]);

const parseArgListI = alternative([
    sequence('argList', [parseArg, terminal('comma'), parseArgList]),
    parseArg,
]);

const parseArgI = sequence('arg', [terminal('identifier'), terminal('colon'), terminal('type')]);

const parseParamListI = alternative([
    sequence('paramList', [parseExpression, terminal('comma'), parseParamList]),
    parseExpression,
]);

const parseExpressionI = alternative([
    parseTernary,
    parseSubtraction,
]);

const parseTernaryI = sequence('ternary', [
    parseSubtraction,
    terminal('ternaryOperator'),
    parseSubtraction,
    terminal('colon'),
    parseSubtraction,
]);

const parseSubtractionI = alternative([
    sequence('subtraction1', [parseProduct, terminal('subtraction'), parseExpression]),
    parseProduct,
]);

const parseProductI = alternative([
    sequence('product1', [parseEquality, terminal('product'), parseProduct]),
    parseEquality,
]);

const parseEqualityI = alternative([
    sequence('equality', [parseSimpleExpression, terminal('equality'), parseEquality]),
    parseSimpleExpression,
]);

const parseSimpleExpressionI = alternative([
    sequence('bracketedExpression', [terminal('leftBracket'), parseExpression, terminal('rightBracket')]),
    sequence('callExpression', [
        terminal('identifier'),
        terminal('leftBracket'),
        parseParamList,
        terminal('rightBracket'),
    ]),
    terminal('number'),
    terminal('booleanLiteral'),
    terminal('identifier'),
    parseFunction,
]);

module.exports = parseProgram;
