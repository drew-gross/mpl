import { terminal, endOfInput } from './parser-combinator.js';

const plus = terminal('sum');
const minus = terminal('subtraction');
const times = terminal('product');
const leftBracket = terminal('leftBracket');
const rightBracket = terminal('rightBracket');
const int = terminal('number');
const identifier = terminal('identifier');
const colon = terminal('colon');
const ternaryOperator = terminal('ternaryOperator');
const type = terminal('type');
const assignment = terminal('assignment');
const _return = terminal('return');
const statementSeparator = terminal('statementSeparator');
const fatArrow = terminal('fatArrow');
const leftCurlyBrace = terminal('leftCurlyBrace');
const rightCurlyBrace = terminal('rightCurlyBrace');
const comma = terminal('comma');
const concatenation = terminal('concatenation');
const equality = terminal('equality');
const boolean = terminal('booleanLiteral');
const stringLiteral = terminal('stringLiteral');

export default {
    program: { n: 'program', p: ['functionBody', endOfInput] },
    function: [
        { n: 'function', p: ['argList', fatArrow, 'expression'] },
        {
            n: 'functionWithBlock',
            p: ['argList', fatArrow, leftCurlyBrace, 'functionBody', rightCurlyBrace],
        },
    ],
    argList: [{ n: 'argList', p: ['arg', comma, 'argList'] }, 'arg'],
    arg: { n: 'arg', p: [identifier, colon, type] },
    functionBody: [
        { n: 'statement', p: ['statement', statementSeparator, 'functionBody'] },
        { n: 'returnStatement', p: [_return, 'expression', statementSeparator] },
        { n: 'returnStatement', p: [_return, 'expression'] },
    ],
    statement: [
        { n: 'typedAssignment', p: [identifier, colon, type, assignment, 'expression'] },
        { n: 'assignment', p: [identifier, assignment, 'expression'] },
    ],
    expression: ['ternary'],
    ternary: [{ n: 'ternary', p: ['addition', ternaryOperator, 'addition', colon, 'addition'] }, 'addition'],
    addition: [{ n: 'addition1', p: ['subtraction', plus, 'addition'] }, 'subtraction'],
    subtraction: [{ n: 'subtraction1', p: ['product', minus, 'subtraction'] }, 'product'],
    product: [{ n: 'product1', p: ['equality', times, 'product'] }, 'equality'],
    equality: [{ n: 'equality', p: ['concatenation', equality, 'equality'] }, 'concatenation'],
    concatenation: [
        { n: 'concatenation', p: ['simpleExpression', concatenation, 'concatenation'] },
        'simpleExpression',
    ],
    simpleExpression: [
        { n: 'bracketedExpression', p: [leftBracket, 'expression', rightBracket] },
        { n: 'callExpression', p: [identifier, leftBracket, 'paramList', rightBracket] },
        int,
        boolean,
        stringLiteral,
        'function',
        identifier,
    ],
    paramList: [{ n: 'paramList', p: ['expression', comma, 'paramList'] }, 'expression'],
};
