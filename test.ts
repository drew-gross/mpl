import test from 'ava';

import { lex, TokenType } from './lex.js';
import { parseMpl, compile } from './frontend.js';
import { compileAndRun } from './test-utils.js';
import grammar from './grammar.js';
import { stripResultIndexes, ParseResult, AstNode, parse } from './parser-combinator.js';
import { removeBracketsFromAst } from './frontend.js';

test('lexer', t => {
    t.deepEqual(lex('123'), [{ type: 'number', value: 123, string: '123' }]);
    t.deepEqual(lex('123 456'), [
        { type: 'number', value: 123, string: '123' },
        { type: 'number', value: 456, string: '456' },
    ]);
    t.deepEqual(lex('&&&&&'), [{ type: 'invalid', value: '&&&&&', string: '&&&&&' }]);
    t.deepEqual(lex('(1)'), [
        { type: 'leftBracket', value: null, string: '(' },
        { type: 'number', value: 1, string: '1' },
        { type: 'rightBracket', value: null, string: ')' },
    ]);
    t.deepEqual(lex('return 100'), [
        { type: 'return', value: null, string: 'return' },
        { type: 'number', value: 100, string: '100' },
    ]);
    t.deepEqual(lex('return "test string"'), [
        { type: 'return', value: null, string: 'return' },
        { type: 'stringLiteral', value: 'test string', string: 'test string' },
    ]);
});

test('lex with initial whitespace', t => {
    t.deepEqual(lex(' 123'), [{ type: 'number', value: 123, string: '123' }]);
});

test('ast for single number', t => {
    const tokens = lex('return 7');
    const parseResult: ParseResult = stripResultIndexes(parse(grammar, 'program', tokens, 0));
    const expectedResult: AstNode = {
        type: 'program' as any,
        children: [
            {
                type: 'returnStatement' as any,
                children: [
                    {
                        type: 'return' as any,
                        value: null,
                    },
                    {
                        type: 'number' as any,
                        value: 7,
                    },
                ],
            },
            {
                type: 'endOfFile' as any,
                value: 'endOfFile',
            },
        ],
    };
    t.deepEqual(parseResult, expectedResult);
});

test('ast for number in brackets', t => {
    t.deepEqual(removeBracketsFromAst(stripResultIndexes(parse(grammar, 'program', lex(' return (5)'), 0))), {
        type: 'program' as any,
        children: [
            {
                type: 'returnStatement' as any,
                children: [
                    {
                        type: 'return' as any,
                        value: null,
                    },
                    {
                        type: 'number' as any,
                        value: 5,
                    },
                ],
            },
            {
                type: 'endOfFile' as any,
                value: 'endOfFile',
            },
        ],
    });
});

test('ast for number in double brackets', t => {
    t.deepEqual(removeBracketsFromAst(stripResultIndexes(parse(grammar, 'program', lex('return ((20))'), 0))), {
        type: 'program' as any,
        children: [
            {
                type: 'returnStatement' as any,
                children: [
                    {
                        type: 'return' as any,
                        value: null,
                    },
                    {
                        type: 'number' as any,
                        value: 20,
                    },
                ],
            },
            {
                type: 'endOfFile' as any,
                value: 'endOfFile',
            },
        ],
    });
});

test('ast for product with brackets', t => {
    t.deepEqual(removeBracketsFromAst(stripResultIndexes(parse(grammar, 'program', lex('return 3 * (4 * 5)'), 0))), {
        type: 'program',
        children: [
            {
                type: 'returnStatement',
                children: [
                    {
                        type: 'return',
                        value: null,
                    },
                    {
                        type: 'product1',
                        children: [
                            {
                                type: 'number',
                                value: 3,
                            },
                            {
                                type: 'product',
                                value: null,
                            },
                            {
                                type: 'product1',
                                children: [
                                    {
                                        type: 'number',
                                        value: 4,
                                    },
                                    {
                                        type: 'product',
                                        value: null,
                                    },
                                    {
                                        type: 'number',
                                        value: 5,
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
            {
                type: 'endOfFile',
                value: 'endOfFile',
            },
        ],
    });
});

test('ast for assignment then return', t => {
    const expected = {
        type: 'program',
        children: [
            {
                type: 'statement',
                children: [
                    {
                        type: 'assignment',
                        children: [
                            {
                                type: 'identifier',
                                value: 'constThree',
                            },
                            {
                                type: 'assignment',
                                value: null,
                            },
                            {
                                type: 'function',
                                children: [
                                    {
                                        type: 'arg',
                                        children: [
                                            {
                                                type: 'identifier',
                                                value: 'a',
                                            },
                                            {
                                                type: 'colon',
                                                value: null,
                                            },
                                            {
                                                type: 'type',
                                                value: 'Integer',
                                            },
                                        ],
                                    },
                                    {
                                        type: 'fatArrow',
                                        value: null,
                                    },
                                    {
                                        type: 'number',
                                        value: 3,
                                    },
                                ],
                            },
                        ],
                    },
                    {
                        type: 'statementSeparator',
                        value: null,
                    },
                    {
                        type: 'returnStatement',
                        children: [
                            {
                                type: 'return',
                                value: null,
                            },
                            {
                                type: 'number',
                                value: 10,
                            },
                        ],
                    },
                ],
            },
            {
                type: 'endOfFile',
                value: 'endOfFile',
            },
        ],
    };
    const astWithSemicolon = removeBracketsFromAst(
        stripResultIndexes(parse(grammar, 'program', lex('constThree = a: Integer => 3; return 10'), 0))
    );
    const astWithNewline = removeBracketsFromAst(
        stripResultIndexes(parse(grammar, 'program', lex('constThree = a: Integer => 3\n return 10'), 0))
    );

    t.deepEqual(astWithSemicolon, expected);
    t.deepEqual(astWithNewline, expected);
});

test('lowering of bracketedExpressions', t => {
    t.deepEqual(parseMpl(lex('return (8 * ((7)))')), {
        parseErrors: [],
        ast: {
            type: 'program',
            children: [
                {
                    type: 'returnStatement',
                    children: [
                        {
                            type: 'return',
                            value: null,
                        },
                        {
                            type: 'product',
                            children: [
                                {
                                    type: 'number',
                                    value: 8,
                                },
                                {
                                    type: 'number',
                                    value: 7,
                                },
                            ],
                        },
                    ],
                },
                {
                    type: 'endOfFile',
                    value: 'endOfFile',
                },
            ],
        },
    });
});

test('bare return', compileAndRun, {
    source: 'return 7',
    expectedExitCode: 7,
});

test('single product', compileAndRun, {
    source: 'return 2 * 2',
    expectedExitCode: 4,
});

test('double product', compileAndRun, {
    source: 'return 5 * 3 * 4',
    expectedExitCode: 60,
    expectedAst: {
        parseErrors: [],
        ast: {
            type: 'program',
            children: [
                {
                    type: 'returnStatement',
                    children: [
                        {
                            type: 'return',
                            value: null,
                        },
                        {
                            type: 'product',
                            children: [
                                {
                                    type: 'product',
                                    children: [
                                        {
                                            type: 'number',
                                            value: 5,
                                        },
                                        {
                                            type: 'number',
                                            value: 3,
                                        },
                                    ],
                                },
                                {
                                    type: 'number',
                                    value: 4,
                                },
                            ],
                        },
                    ],
                },
                {
                    type: 'endOfFile',
                    value: 'endOfFile',
                },
            ],
        },
    },
});

test('brackets', compileAndRun, {
    source: 'return (3)',
    expectedExitCode: 3,
});

test('brackets product', compileAndRun, {
    source: 'return (3 * 4) * 5',
    expectedExitCode: 60,
    expectedAst: {
        parseErrors: [],
        ast: {
            type: 'program',
            children: [
                {
                    type: 'returnStatement',
                    children: [
                        {
                            type: 'return',
                            value: null,
                        },
                        {
                            type: 'product',
                            children: [
                                {
                                    type: 'product',
                                    children: [
                                        {
                                            type: 'number',
                                            value: 3,
                                        },
                                        {
                                            type: 'number',
                                            value: 4,
                                        },
                                    ],
                                },
                                {
                                    type: 'number',
                                    value: 5,
                                },
                            ],
                        },
                    ],
                },
                {
                    type: 'endOfFile',
                    value: 'endOfFile',
                },
            ],
        },
    },
});

test('assign function and return', compileAndRun, {
    source: 'constThree = a: Integer => 3; return 10',
    expectedExitCode: 10,
});

test('assign function and call it', compileAndRun, {
    source: 'takeItToEleven = a: Integer => 11; return takeItToEleven(0)',
    expectedExitCode: 11,
});

test('multiple variables called', compileAndRun, {
    source: `
const11 = a: Integer => 11
const12 = a: Integer => 12
return const11(1) * const12(2)`,
    expectedExitCode: 132,
});

test('double product with brackets', compileAndRun, {
    source: 'return 2 * (3 * 4) * 5',
    expectedExitCode: 120,
    expectedAst: {
        parseErrors: [],
        ast: {
            type: 'program',
            children: [
                {
                    type: 'returnStatement',
                    children: [
                        {
                            type: 'return',
                            value: null,
                        },
                        {
                            type: 'product',
                            children: [
                                {
                                    type: 'product',
                                    children: [
                                        {
                                            type: 'number',
                                            value: 2,
                                        },
                                        {
                                            type: 'product',
                                            children: [
                                                {
                                                    type: 'number',
                                                    value: 3,
                                                },
                                                {
                                                    type: 'number',
                                                    value: 4,
                                                },
                                            ],
                                        },
                                    ],
                                },
                                {
                                    type: 'number',
                                    value: 5,
                                },
                            ],
                        },
                    ],
                },
                {
                    type: 'endOfFile',
                    value: 'endOfFile',
                },
            ],
        },
    },
});

test('id function', compileAndRun, {
    source: 'id = a: Integer => a; return id(5)',
    expectedExitCode: 5,
});

test('double function', compileAndRun, {
    source: 'doubleIt = a: Integer => 2 * a; return doubleIt(100)',
    expectedExitCode: 200,
});

test('subtraction', compileAndRun, {
    source: 'return 7 - 5',
    expectedExitCode: 2,
});

test('order of operations', compileAndRun, {
    source: 'return 2 * 5 - 1',
    expectedExitCode: 9,
});

test('associativity of subtraction', compileAndRun, {
    source: 'return 5 - 2 - 1',
    expectedExitCode: 2,
});

test('ternary true', compileAndRun, {
    source: 'return 1 == 1 ? 5 : 6',
    expectedExitCode: 5,
});

test('ternary false', compileAndRun, {
    source: 'return 0 == 1 ? 5 : 6',
    expectedExitCode: 6,
});

test('parse error', compileAndRun, {
    source: '=>',
    expectedParseErrors: ['Expected identifier or return, found fatArrow'],
});

test('ternary in function false', compileAndRun, {
    source: `
ternary = a: Boolean => a ? 9 : 5
return ternary(false)`,
    expectedExitCode: 5,
});

test('ternary in function then subtract', compileAndRun, {
    source: `
ternaryFunc = a:Boolean => a ? 9 : 3
return ternaryFunc(true) - ternaryFunc(false)`,
    expectedExitCode: 6,
});

test('equality comparison true', compileAndRun, {
    source: `
isFive = five: Integer => five == 5 ? 2 : 7
return isFive(5)`,
    expectedExitCode: 2,
});

test('equality comparison false', compileAndRun, {
    source: `
isFive = notFive: Integer => notFive == 5 ? 2 : 7
return isFive(11)`,
    expectedExitCode: 7,
});

test('factorial', compileAndRun, {
    source: `
factorial = x: Integer => x == 1 ? 1 : x * factorial(x - 1)
return factorial(5)`,
    expectedExitCode: 120,
});

test('return bool fail', compileAndRun, {
    source: 'return 1 == 2',
    expectedTypeErrors: ['You tried to return a Boolean'],
});

test('boolean literal false', compileAndRun, {
    source: `return false ? 1 : 2`,
    expectedExitCode: 2,
});

test('boolean literal true', compileAndRun, {
    source: `return true ? 1 : 2`,
    expectedExitCode: 1,
});

test('wrong type for arg', compileAndRun, {
    source: `
boolFunc = a: Boolean => 1
return boolFunc(7)`,
    expectedTypeErrors: ['You passed a Integer as an argument to boolFunc. It expects a Boolean'],
});

test('assign wrong type', compileAndRun, {
    source: 'myInt: Integer = false; return myInt;',
    expectedTypeErrors: ['You tried to assign a Boolean to "myInt", which has type Integer'],
});

// Needs function types with args in syntax
test.failing('assign function to typed var', compileAndRun, {
    source: 'myFunc: Function = a: Integer => a; return a(37);',
    expectedExitCode: 37,
});

test('return local integer', compileAndRun, {
    source: 'myVar: Integer = 3 * 3; return myVar',
    expectedExitCode: 9,
});

test('many temporaries, spill to ram', compileAndRun, {
    source: 'return 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1',
    expectedExitCode: 1,
});

test('multi statement function with locals', compileAndRun, {
    source: `
quadrupleWithLocal = a: Integer => { b: Integer = 2 * a; return 2 * b }
return quadrupleWithLocal(5);`,
    expectedExitCode: 20,
});

test('mutil statement function with type error', compileAndRun, {
    source: `
boolTimesInt = a: Integer => { b: Boolean = false; return a * b }
return boolTimesInt(1);`,
    expectedTypeErrors: ['Right hand side of product was not integer'],
});

// TODO: rethink statment separators
test.failing('multi statement function on multiple lines', compileAndRun, {
    source: `
quadrupleWithLocal = a: Integer => {
    b: Integer = 2 * a
    return 2 * b
}

return quadrupleWithLocal(5);`,
    expectedExitCode: 20,
});

test('string length', compileAndRun, {
    source: `myStr: String = "test"; return length(myStr);`,
    expectedExitCode: 4,
});

test('empty string length', compileAndRun, {
    source: `myStr: String = ""; return length(myStr);`,
    expectedExitCode: 0,
});

test('string length with type inferred', compileAndRun, {
    source: `myStr = "test2"; return length(myStr);`,
    expectedExitCode: 5,
});

test('struture is equal for inferred string type', t => {
    const inferredStructure = compile('myStr = "test"; return length(myStr);');
    const suppliedStructure = compile('myStr: String = "test"; return length(myStr);');
    t.deepEqual(inferredStructure, suppliedStructure);
});

test('string copy', compileAndRun, {
    source: `myStr1: String = "testing"; myStr2: String = myStr1; return length(myStr2);`,
    expectedExitCode: 7,
});

test('string equality: equal', compileAndRun, {
    source: `str1 = "a"
str2 = "a"
return str1 == str2 ? 1 : 2
`,
    expectedExitCode: 1,
});

test('string equality: inequal same length', compileAndRun, {
    source: `str1 = "a"
str2 = "b"
return str1 == str2 ? 1 : 2
`,
    expectedExitCode: 2,
});

test('string equality: inequal different length', compileAndRun, {
    source: `str1 = "aa"
str2 = "a"
return str1 == str2 ? 7 : 2
`,
    expectedExitCode: 2,
});

test('wrong type global', compileAndRun, {
    source: `str: String = 5; return length(str)`,
    expectedTypeErrors: ['You tried to assign a Integer to "str", which has type String'],
});

test('string concatenation', compileAndRun, {
    source: `str1: String = "a"
str2: String = "b"
return str1 ++ str2 == "ab" ? 5 : 10`,
    expectedExitCode: 5,
});

test('concatenate and get length then subtract', compileAndRun, {
    source: `return length("abc" ++ "defg") - 2;`,
    expectedExitCode: 5,
});

// TODO: Problem extracting variables
test('semi-complex string concatenation', compileAndRun, {
    source: `lenFunc = dummy: Integer => { str1 = "abc"; str2 = str1 ++ str1; return str2 == "abcabc" ? 40 : 50 }
return lenFunc(5)`,
    expectedExitCode: 40,
});

// TODO: causes bad behaviour in parser, takes forever
test.failing('complex string concatenation', compileAndRun, {
    source: `lenFunc = dummy: Integer => {
    str1 = "abc"
    str2 = "def"
    str3 = "abc"
    concat1 = str1 ++ str2 ++ str3
    concat2 = str3 ++ str2 ++ str3
    return concat1 == concat2 ? (length(str1 ++ str2)) : 99
}
return lenFunc(5)`,
    expectedExitCode: 6,
});

test('parsing fails for extra invalid tokens', compileAndRun, {
    source: `return 5 (`,
    expectedParseErrors: ['Expected endOfFile, found leftBracket'],
});

test('addition', compileAndRun, {
    source: `return length("foo") + 5`,
    expectedExitCode: 8,
});
