import { ThreeAddressStatement, ThreeAddressFunction } from './backends/threeAddressCode.js';
import * as threeAddressCodeRuntime from './backends/threeAddressCodeRuntime.js';
import test from 'ava';
import flatten from './util/list/flatten.js';
import { lex } from './lex.js';
import {
    parseMpl,
    compile,
    typeCheckStatement,
    astFromParseResult,
    typeOfExpression,
    builtinTypes,
} from './frontend.js';
import { compileAndRun } from './test-utils.js';
import { grammar, tokenSpecs, MplParseResult, MplAst } from './grammar.js';
import {
    stripResultIndexes,
    ParseResult,
    parse,
    parseResultIsError,
    stripSourceLocation,
} from './parser-combinator.js';
import { removeBracketsFromAst } from './frontend.js';
import { controlFlowGraph, toDotFile, BasicBlock, computeBlockLiveness, tafLiveness } from './controlFlowGraph.js';
import debug from './util/debug.js';

test('double flatten', t => {
    t.deepEqual(flatten(flatten([[[1, 2]], [[3], [4]], [[5]]])), [1, 2, 3, 4, 5]);
});

test('lexer', t => {
    t.deepEqual(lex(tokenSpecs, '123'), [
        { type: 'number', value: 123, string: '123', sourceLine: 1, sourceColumn: 1 },
    ]);
    t.deepEqual(lex(tokenSpecs, '123 456'), [
        { type: 'number', value: 123, string: '123', sourceLine: 1, sourceColumn: 1 },
        { type: 'number', value: 456, string: '456', sourceLine: 1, sourceColumn: 5 },
    ]);
    t.deepEqual(lex(tokenSpecs, '&&&&&'), [
        { type: 'invalid', value: '&&&&&', string: '&&&&&', sourceLine: 1, sourceColumn: 1 },
    ]);
    t.deepEqual(lex(tokenSpecs, '(1)'), [
        { type: 'leftBracket', value: null, string: '(', sourceLine: 1, sourceColumn: 1 },
        { type: 'number', value: 1, string: '1', sourceLine: 1, sourceColumn: 2 },
        { type: 'rightBracket', value: null, string: ')', sourceLine: 1, sourceColumn: 3 },
    ]);
    t.deepEqual(lex(tokenSpecs, 'return 100'), [
        { type: 'return', value: null, string: 'return', sourceLine: 1, sourceColumn: 1 },
        { type: 'number', value: 100, string: '100', sourceLine: 1, sourceColumn: 8 },
    ]);
    t.deepEqual(lex(tokenSpecs, 'return "test string"'), [
        { type: 'return', value: null, string: 'return', sourceLine: 1, sourceColumn: 1 },
        { type: 'stringLiteral', value: 'test string', string: 'test string', sourceLine: 1, sourceColumn: 8 },
    ]);
});

test('lex with initial whitespace', t => {
    t.deepEqual(lex(tokenSpecs, ' 123'), [
        { type: 'number', value: 123, string: '123', sourceLine: 1, sourceColumn: 2 },
    ]);
});

test('ast for single number', t => {
    const tokens = lex(tokenSpecs, 'return 7;');
    const parseResult = stripResultIndexes(parse(grammar, 'program', tokens, 0));
    if (parseResultIsError(parseResult)) {
        t.fail('Parse Failed');
        return;
    }
    const expectedResult = {
        type: 'program',
        children: [
            {
                type: 'returnStatement',
                sourceLine: 1,
                sourceColumn: 1,
                children: [
                    {
                        type: 'return',
                        value: null,
                        sourceLine: 1,
                        sourceColumn: 1,
                    },
                    {
                        type: 'number',
                        value: 7,
                        sourceLine: 1,
                        sourceColumn: 8,
                    },
                    {
                        type: 'statementSeparator',
                        value: null,
                        sourceLine: 1,
                        sourceColumn: 9,
                    },
                ],
            },
            {
                type: 'endOfFile',
                value: 'endOfFile',
                sourceLine: 1,
                sourceColumn: 10,
            },
        ],
        sourceLine: 1,
        sourceColumn: 1,
    } as MplAst;
    t.deepEqual(expectedResult, parseResult);
});

test('ast for number in brackets', t => {
    t.deepEqual(
        removeBracketsFromAst(stripResultIndexes(parse(grammar, 'program', lex(tokenSpecs, ' return (5);'), 0))),
        {
            type: 'program',
            sourceLine: 1,
            sourceColumn: 2,
            children: [
                {
                    type: 'returnStatement',
                    sourceLine: 1,
                    sourceColumn: 2,
                    children: [
                        {
                            type: 'return',
                            value: null,
                            sourceLine: 1,
                            sourceColumn: 2,
                        },
                        {
                            type: 'number',
                            value: 5,
                            sourceLine: 1,
                            sourceColumn: 10,
                        },
                        {
                            type: 'statementSeparator',
                            value: null,
                            sourceLine: 1,
                            sourceColumn: 12,
                        },
                    ],
                },
                {
                    type: 'endOfFile',
                    value: 'endOfFile',
                    sourceLine: 1,
                    sourceColumn: 13,
                },
            ],
        }
    );
});

test('ast for number in double brackets', t => {
    t.deepEqual(
        removeBracketsFromAst(stripResultIndexes(parse(grammar, 'program', lex(tokenSpecs, 'return ((20));'), 0))),
        {
            type: 'program',
            sourceLine: 1,
            sourceColumn: 1,
            children: [
                {
                    type: 'returnStatement',
                    sourceLine: 1,
                    sourceColumn: 1,
                    children: [
                        {
                            type: 'return',
                            value: null,
                            sourceLine: 1,
                            sourceColumn: 1,
                        },
                        {
                            type: 'number',
                            value: 20,
                            sourceLine: 1,
                            sourceColumn: 10,
                        },
                        {
                            type: 'statementSeparator',
                            value: null,
                            sourceLine: 1,
                            sourceColumn: 14,
                        },
                    ],
                },
                {
                    type: 'endOfFile',
                    value: 'endOfFile',
                    sourceLine: 1,
                    sourceColumn: 15,
                },
            ],
        }
    );
});

test('ast for product with brackets', t => {
    t.deepEqual(
        removeBracketsFromAst(stripResultIndexes(parse(grammar, 'program', lex(tokenSpecs, 'return 3 * (4 * 5);'), 0))),
        {
            type: 'program',
            sourceLine: 1,
            sourceColumn: 1,
            children: [
                {
                    type: 'returnStatement',
                    sourceLine: 1,
                    sourceColumn: 1,
                    children: [
                        {
                            type: 'return',
                            sourceLine: 1,
                            sourceColumn: 1,
                            value: null,
                        },
                        {
                            type: 'product',
                            sourceLine: 1,
                            sourceColumn: 8,
                            children: [
                                {
                                    type: 'number',
                                    value: 3,
                                    sourceLine: 1,
                                    sourceColumn: 8,
                                },
                                {
                                    type: 'product',
                                    value: null,
                                    sourceLine: 1,
                                    sourceColumn: 10,
                                },
                                {
                                    type: 'product',
                                    sourceLine: 1,
                                    sourceColumn: 13,
                                    children: [
                                        {
                                            type: 'number',
                                            value: 4,
                                            sourceLine: 1,
                                            sourceColumn: 13,
                                        },
                                        {
                                            type: 'product',
                                            value: null,
                                            sourceLine: 1,
                                            sourceColumn: 15,
                                        },
                                        {
                                            type: 'number',
                                            value: 5,
                                            sourceLine: 1,
                                            sourceColumn: 17,
                                        },
                                    ],
                                },
                            ],
                        },
                        {
                            type: 'statementSeparator',
                            value: null,
                            sourceLine: 1,
                            sourceColumn: 19,
                        },
                    ],
                },
                {
                    type: 'endOfFile',
                    value: 'endOfFile',
                    sourceLine: 1,
                    sourceColumn: 20,
                },
            ],
        }
    );
});

test('ast for assignment then return', t => {
    const expected = {
        type: 'program',
        children: [
            {
                type: 'statement',
                children: [
                    {
                        type: 'declarationAssignment',
                        children: [
                            {
                                type: 'identifier',
                                value: 'constThree',
                            },
                            {
                                type: 'colon',
                                value: null,
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
                                                type: 'typeWithoutArgs',
                                                children: [
                                                    {
                                                        type: 'typeIdentifier',
                                                        value: 'Integer',
                                                    },
                                                ],
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
                            {
                                type: 'statementSeparator',
                                value: null,
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
    const astWithSemicolon = stripSourceLocation(
        removeBracketsFromAst(
            stripResultIndexes(
                parse(grammar, 'program', lex(tokenSpecs, 'constThree := a: Integer => 3; return 10;'), 0)
            )
        )
    );
    t.deepEqual(astWithSemicolon, expected);
});

test('lowering of bracketedExpressions', t => {
    t.deepEqual(stripSourceLocation(parseMpl(lex(tokenSpecs, 'return (8 * ((7)))'))), {
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
                                type: 'product',
                                value: null,
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
                                        type: 'product',
                                        value: null,
                                    },
                                    {
                                        type: 'number',
                                        value: 3,
                                    },
                                ],
                            },
                            {
                                type: 'product',
                                value: null,
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
});

test('brackets', compileAndRun, {
    source: 'return (3)',
    expectedExitCode: 3,
});

test('brackets product', compileAndRun, {
    source: 'return (3 * 4) * 5',
    expectedExitCode: 60,
    expectedAst: {
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
                                        type: 'product',
                                        value: null,
                                    },
                                    {
                                        type: 'number',
                                        value: 4,
                                    },
                                ],
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
            {
                type: 'endOfFile',
                value: 'endOfFile',
            },
        ],
    },
});

test('assign function and return', compileAndRun, {
    source: 'constThree := a: Integer => 3; return 10',
    expectedExitCode: 10,
});

test('correct inferred type for function', t => {
    const functionSource = 'a: Integer => 11';
    const parseResult: MplParseResult = parse(grammar, 'function', lex(tokenSpecs, functionSource), 0);
    const ast = astFromParseResult(parseResult as MplAst);
    t.deepEqual(typeOfExpression(ast, []), {
        name: 'Function',
        arguments: [
            {
                name: 'Integer',
                arguments: [],
            },
            {
                name: 'Integer',
                arguments: [],
            },
        ],
    });
});

test('assign function and call it', compileAndRun, {
    source: 'takeItToEleven := a: Integer => 11; return takeItToEleven(0)',
    expectedExitCode: 11,
});

test('multiple variables called', compileAndRun, {
    source: `
const11 := a: Integer => 11;
const12 := a: Integer => 12;
return const11(1) * const12(2);`,
    expectedExitCode: 132,
});

test('double product with brackets', compileAndRun, {
    source: 'return 2 * (3 * 4) * 5',
    expectedExitCode: 120,
    expectedAst: {
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
                                        value: null,
                                    },
                                    {
                                        type: 'product',
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
                                                type: 'number',
                                                value: 4,
                                            },
                                        ],
                                    },
                                ],
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
            {
                type: 'endOfFile',
                value: 'endOfFile',
            },
        ],
    },
});

test('id function', compileAndRun, {
    source: 'id := a: Integer => a; return id(5)',
    expectedExitCode: 5,
});

test('double function', compileAndRun, {
    source: 'doubleIt := a: Integer => 2 * a; return doubleIt(100)',
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
    expectedParseErrors: [
        {
            kind: 'unexpectedToken',
            found: ['fatArrow'],
            expected: ['identifier', 'return'],
            sourceLine: 1,
            sourceColumn: 1,
        },
    ],
});

test('ternary in function false', compileAndRun, {
    source: `
ternary := a: Boolean => a ? 9 : 5;
return ternary(false);`,
    expectedExitCode: 5,
});

test('ternary in function then subtract', compileAndRun, {
    source: `
ternaryFunc := a:Boolean => a ? 9 : 3;
return ternaryFunc(true) - ternaryFunc(false);`,
    expectedExitCode: 6,
});

test('equality comparison true', compileAndRun, {
    source: `
isFive := five: Integer => five == 5 ? 2 : 7;
return isFive(5);`,
    expectedExitCode: 2,
});

test('equality comparison false', compileAndRun, {
    source: `
isFive := notFive: Integer => notFive == 5 ? 2 : 7;
return isFive(11);`,
    expectedExitCode: 7,
});

test('factorial', compileAndRun, {
    source: `
factorial := x: Integer => x == 1 ? 1 : x * factorial(x - 1);
return factorial(5);`,
    expectedExitCode: 120,
});

test('return bool fail', compileAndRun, {
    source: 'return 1 == 2',
    expectedTypeErrors: [
        {
            kind: 'wrongTypeReturn',
            expressionType: builtinTypes.Boolean,
            sourceLine: 1,
            sourceColumn: 1,
        },
    ],
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
boolFunc := a: Boolean => 1;
return boolFunc(7);`,
    expectedTypeErrors: [
        {
            kind: 'wrongArgumentType',
            targetFunction: 'boolFunc',
            passedType: builtinTypes.Integer,
            expectedType: builtinTypes.Boolean,
            sourceLine: 3,
            sourceColumn: 8,
        },
    ],
});

test('assign wrong type', compileAndRun, {
    source: 'myInt: Integer = false; return myInt;',
    expectedTypeErrors: [
        {
            kind: 'assignWrongType',
            lhsName: 'myInt',
            lhsType: builtinTypes.Integer,
            rhsType: builtinTypes.Boolean,
            sourceLine: 1,
            sourceColumn: 1,
        },
    ],
});

test('assign function to typed var', compileAndRun, {
    source: 'myFunc: Function<Integer, Integer> = a: Integer => a; return myFunc(37);',
    expectedExitCode: 37,
});

test('assign function with multiple args to typed var', compileAndRun, {
    source: `
myFunc: Function<Integer, String, Integer> = (a: Integer, b: String) => a + length(b);
return myFunc(4, "four");`,
    expectedExitCode: 8,
});

test('assign function with no args to typed var', compileAndRun, {
    source: `
myFunc: Function<Integer> = () => 111;
return myFunc();`,
    expectedExitCode: 111,
});

test('assign function to wrong args number', compileAndRun, {
    source: `
myFunc: Function<Integer, Integer> = () => 111;
return myFunc();`,
    expectedTypeErrors: [
        {
            kind: 'assignWrongType',
            lhsName: 'myFunc',
            lhsType: {
                name: 'Function',
                arguments: [builtinTypes.Integer, builtinTypes.Integer],
            },
            rhsType: {
                name: 'Function',
                arguments: [builtinTypes.Integer],
            },
            sourceLine: 2,
            sourceColumn: 1,
        },
    ],
});

test('assign function to wrong args type', compileAndRun, {
    source: `
myFunc: Function<Integer, Integer> = (a: String) => 111;
return myFunc("");`,
    expectedTypeErrors: [
        {
            kind: 'assignWrongType',
            lhsName: 'myFunc',
            lhsType: {
                name: 'Function',
                arguments: [builtinTypes.Integer, builtinTypes.Integer],
            },
            rhsType: {
                name: 'Function',
                arguments: [builtinTypes.String, builtinTypes.Integer],
            },
            sourceLine: 2,
            sourceColumn: 1,
        },
    ],
});

// Need return types
test.failing('return boolean', compileAndRun, {
    source: `
isFive: Function<Integer, Boolean> = a: Integer => a == 5;
return isFive(5) ? 1 : 0`,
    expectedExitCode: 1,
});

// Need return types
test.failing('return string', compileAndRun, {
    source: `
isFive: Function<Integer, Boolean> = a: Integer => a == 5 ? "isFive" : "isNotFive";
return length(isFive(5))`,
    expectedExitCode: 6,
});

test('assign function to wrong return type', compileAndRun, {
    source: `
myFunc: Function<Integer, Boolean> = (a: String) => 111;
return myFunc("");`,
    expectedTypeErrors: [
        {
            kind: 'assignWrongType',
            lhsName: 'myFunc',
            lhsType: {
                name: 'Function',
                arguments: [builtinTypes.Integer, builtinTypes.Boolean],
            },
            rhsType: {
                name: 'Function',
                arguments: [builtinTypes.String, builtinTypes.Integer],
            },
            sourceLine: 2,
            sourceColumn: 1,
        },
    ],
});

test('return local integer', compileAndRun, {
    source: 'myVar: Integer = 3 * 3; return myVar',
    expectedExitCode: 9,
});

// Need spilling
test.failing('many temporaries, spill to ram', compileAndRun, {
    source: 'return 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1',
    expectedExitCode: 1,
});

test('multi statement function with locals', compileAndRun, {
    source: `
quadrupleWithLocal := a: Integer => { b: Integer = 2 * a; return 2 * b; };
return quadrupleWithLocal(5);`,
    expectedExitCode: 20,
});

test('mutil statement function with type error', compileAndRun, {
    source: `
boolTimesInt := a: Integer => { b: Boolean = false; return a * b; };
return boolTimesInt(1);`,
    expectedTypeErrors: [
        {
            kind: 'wrongTypeForOperator',
            operator: 'product',
            side: 'right',
            found: builtinTypes.Boolean,
            expected: 'Integer',
            sourceLine: 2,
            sourceColumn: 60,
        },
    ],
});

test('multi statement function on multiple lines', compileAndRun, {
    source: `
quadrupleWithLocal := a: Integer => {
    b: Integer = 2 * a;
    return 2 * b;
};

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
    source: `myStr := "test2"; return length(myStr);`,
    expectedExitCode: 5,
});

test('structure is equal for inferred string type', t => {
    const inferredStructure = compile('myStr := "test"; return length(myStr);');
    const suppliedStructure = compile('myStr: String = "test"; return length(myStr);');
    // TODO:  remove this awful hack. Need to either strip source location from structure,
    // or not have it there in the first place.
    (inferredStructure as any).program.statements[0].expression.sourceColumn = 17;
    (inferredStructure as any).program.statements[1].expression.arguments[0].sourceColumn = 39;
    t.deepEqual(inferredStructure, suppliedStructure);
});

test('string copy', compileAndRun, {
    source: `myStr1: String = "testing"; myStr2: String = myStr1; return length(myStr2);`,
    expectedExitCode: 7,
});

test('string equality: equal', compileAndRun, {
    source: `str1 := "a";
str2 := "a";
return str1 == str2 ? 1 : 2;
`,
    expectedExitCode: 1,
});

test('string equality: inequal same length', compileAndRun, {
    source: `str1 := "a";
str2 := "b";
return str1 == str2 ? 1 : 2;
`,
    expectedExitCode: 2,
});

test('string equality: inequal different length', compileAndRun, {
    source: `str1 := "aa";
str2 := "a";
return str1 == str2 ? 7 : 2;
`,
    expectedExitCode: 2,
});

test('wrong type global', compileAndRun, {
    source: `str: String = 5; return length(str);`,
    expectedTypeErrors: [
        {
            kind: 'assignWrongType',
            lhsName: 'str',
            lhsType: builtinTypes.String,
            rhsType: builtinTypes.Integer,
            sourceLine: 1,
            sourceColumn: 1,
        },
    ],
});

test('string concatenation', compileAndRun, {
    source: `str1: String = "a";
str2: String = "b";
return str1 ++ str2 == "ab" ? 5 : 10;`,
    expectedExitCode: 5,
});

test('concatenate and get length then subtract', compileAndRun, {
    source: `return length("abc" ++ "defg") - 2;`,
    expectedExitCode: 5,
});

test('semi-complex string concatenation', compileAndRun, {
    source: `
lenFunc := dummy: Integer => {
    str1 := "abc";
    str2 := str1 ++ str1;
    return str2 == "abcabc" ? 40 : 50;
};
return lenFunc(5);`,
    expectedExitCode: 40,
});

// TODO: Needs register allocator with proper spilling
test.failing('complex string concatenation', compileAndRun, {
    source: `lenFunc := dummy: Integer => {
    str1 := "abc";
    str2 := "def";
    str3 := "abc";
    concat1 := str1 ++ str2 ++ str3;
    concat2 := str3 ++ str2 ++ str3;
    return concat1 == concat2 ? (length(str1 ++ str2)) : 99;
};
return lenFunc(5);`,
    expectedExitCode: 6,
});

test('parsing fails for extra invalid tokens', compileAndRun, {
    source: `return 5 (`,
    expectedParseErrors: [
        {
            kind: 'unexpectedToken',
            found: ['leftBracket'],
            expected: ['endOfFile'],
            sourceLine: 1,
            sourceColumn: 10,
        },
    ],
});

test('addition', compileAndRun, {
    source: `return length("foo") + 5;`,
    expectedExitCode: 8,
});

test('two args', compileAndRun, {
    source: `
myAdd := a: Integer, b: Integer => a + b;
return myAdd(7, 4);`,
    expectedExitCode: 11,
});

test('two args with expression argument', compileAndRun, {
    source: `
myAdd := a: Integer, b: Integer => a + b;
return myAdd(7 + 7, 4);`,
    expectedExitCode: 18,
});

test('three args', compileAndRun, {
    source: `
myAdd := a: Integer, b: Integer, c: Integer => a + b + c;
return myAdd(7, 4, 5);`,
    expectedExitCode: 16,
});

test('zero args', compileAndRun, {
    source: `
const11 := () => 11;
return const11();`,
    expectedExitCode: 11,
});

test('one bracketed arg', compileAndRun, {
    source: `
times11 := (a: Integer) => a * 11;
return times11(1);`,
    expectedExitCode: 11,
});

test('two bracketed args', compileAndRun, {
    source: `
timess := (a: Integer, b: Integer) => a * b;
return timess(11, 1);`,
    expectedExitCode: 11,
});

test.failing('function named times', compileAndRun, {
    source: `
times := (a: Integer, b: Integer) => a * b;
return times(11, 1);`,
    expectedExitCode: 11,
});

test('call with wrong number of args', compileAndRun, {
    source: `
threeArgs := a: Integer, b: Integer, c: Integer => a + b + c;
return threeArgs(7, 4);`,
    expectedTypeErrors: [
        {
            kind: 'wrongNumberOfArguments',
            targetFunction: 'threeArgs',
            passedArgumentCount: 2,
            expectedArgumentCount: 3,
            sourceLine: 3,
            sourceColumn: 8,
        },
    ],
});

test('call with wrong arg type', compileAndRun, {
    source: `
threeArgs := a: Integer, b: Integer, c: Integer => a + b + c;
return threeArgs(7, 4, "notAnInteger");`,
    expectedTypeErrors: [
        {
            kind: 'wrongArgumentType',
            targetFunction: 'threeArgs',
            expectedType: builtinTypes.Integer,
            passedType: builtinTypes.String,
            sourceColumn: 8,
            sourceLine: 3,
        },
    ],
});

test('print', compileAndRun, {
    source: `
dummy := print("sample_string");
return 1;`,
    expectedExitCode: 1,
    expectedStdOut: 'sample_string',
});

test('print string with space', compileAndRun, {
    source: `
dummy := print("sample string with space");
return 1;`,
    expectedExitCode: 1,
    expectedStdOut: 'sample string with space',
});

test.failing('require/force no return value for print', compileAndRun, {
    source: `
print("sample string");
return 1;`,
    expectedExitCode: 1,
    expectedStdOut: 'sample string',
});

test('print string containing number', compileAndRun, {
    source: `
dummy := print("1");
return 1 + dummy - dummy;`,
    expectedExitCode: 1,
    expectedStdOut: '1',
    // Fails mips because of the silly way we extract exit codes.
    failing: ['mips'],
});

test('assign result of call to builtin to local in function', compileAndRun, {
    source: `
lengthOfFoo := (dummy: Integer) => {
    dumme := length("foo");
    return dumme;
};
return lengthOfFoo(1);`,
    expectedExitCode: 3,
});

test('string args', compileAndRun, {
    source: `
excitmentifier := (boring: String) => {
    dummy := print(boring ++ "!");
    return 11 + dummy - dummy;
};
return excitmentifier("Hello World");`,
    expectedStdOut: 'Hello World!',
    expectedExitCode: 11,
});

test('reassign integer', compileAndRun, {
    source: `
a := 1;
bb := a + 5;
a = 2;
c := a + bb;
return c;`,
    expectedExitCode: 8,
});

test('reassign to undeclared identifier', compileAndRun, {
    source: `
a := 1;
b = 2;
return a + b;`,
    expectedTypeErrors: [{ kind: 'assignUndeclaredIdentifer', destinationName: 'b', sourceLine: 3, sourceColumn: 1 }],
});

test('reassigning wrong type', compileAndRun, {
    source: `
a := 1;
a = true;
return a;`,
    expectedTypeErrors: [
        {
            kind: 'assignWrongType',
            lhsName: 'a',
            lhsType: builtinTypes.Integer,
            rhsType: builtinTypes.Boolean,
            sourceLine: 3,
            sourceColumn: 1,
        },
    ],
});

test('reassign string', compileAndRun, {
    source: `
a := "Hello";
dummy := print(a);
a = "World!!!!!";
dummy = print(a);
return dummy - dummy;`,
    expectedExitCode: 0,
    expectedStdOut: 'HelloWorld!!!!!',
});

test('reassign to a using expression including a', compileAndRun, {
    source: `
hello := "HelloWorld";
hello = hello ++ "!";
return length(hello);`,
    expectedExitCode: 11,
});

test.failing('good parse error for missing semi-colon', compileAndRun, {
    source: `
foo = () => {
    return 1;
}
return foo();`,
    expectedParseErrors: ['you forgot a semi-colon'],
});

test('reassign integer inside function', compileAndRun, {
    source: `
foo := () => {
    a := 1;
    b := a + 5;
    a = 2;
    c := a + b;
    return c;
};
return foo();`,
    expectedExitCode: 8,
});

test('reassign to undeclared identifier inside function', compileAndRun, {
    source: `
foo := () => {
    a := 1;
    b = 2;
    return a + b;
};
return foo()`,
    expectedTypeErrors: [
        {
            kind: 'assignUndeclaredIdentifer',
            destinationName: 'b',
            sourceLine: 4,
            sourceColumn: 5,
        },
    ],
});

test('reassigning wrong type inside function', compileAndRun, {
    source: `
foo := () => {
    a := 1;
    a = true;
    return a;
};
return foo();`,
    expectedTypeErrors: [
        {
            kind: 'assignWrongType',
            lhsName: 'a',
            lhsType: builtinTypes.Integer,
            rhsType: builtinTypes.Boolean,
            sourceLine: 4,
            sourceColumn: 5,
        },
    ],
});

test.failing('reassign string inside function', compileAndRun, {
    source: `
foo := () => {
    a := "Hello";
    dummy := print(a);
    a = "World!!!!!";
    dummy = print(a);
    return dummy - dummy;
};
return foo();
`,
    expectedExitCode: 0,
    expectedStdOut: 'HelloWorld!!!!!',
});

test.failing('variable named b', compileAndRun, {
    source: `
b := 2;
return b;`,
    expectedExitCode: 2,
});

test('controlFlowGraph basic test', t => {
    const rtl: ThreeAddressStatement[] = [
        {
            kind: 'functionLabel',
            name: 'test',
            why: 'test',
        },
        {
            kind: 'returnToCaller',
            why: 'test',
        },
    ];
    const cfg = controlFlowGraph(rtl);
    t.deepEqual(cfg.blocks.length, 1);
    t.deepEqual(cfg.connections.length, 0);
    t.deepEqual(cfg.exits.length, 1);
});

test('computeBlockLiveness basic test', t => {
    const block: BasicBlock = {
        name: 'test',
        instructions: [
            {
                kind: 'add',
                lhs: { name: 'l' },
                rhs: { name: 'r' },
                destination: { name: 'd' },
                why: 'd = l + r',
            },
            {
                kind: 'subtract',
                lhs: { name: 'l2' },
                rhs: { name: 'd' },
                destination: { name: 'r' },
                why: 'r = l2 - d',
            },
            {
                kind: 'move',
                from: { name: 'l' },
                to: { name: 'v' },
                why: 'v = l (dead)',
            },
            {
                kind: 'move',
                from: { name: 'r' },
                to: { name: 'v' },
                why: 'v = r',
            },
        ],
    };
    const liveness = computeBlockLiveness(block);
    const expected = [
        [{ name: 'l' }, { name: 'l2' }, { name: 'r' }],
        [{ name: 'l' }, { name: 'l2' }, { name: 'd' }],
        [{ name: 'r' }, { name: 'l' }],
        [{ name: 'r' }],
        [],
    ];
    t.deepEqual(liveness.length, expected.length);
    expected.forEach((e, i) => {
        t.deepEqual(e.sort(), liveness[i].toList().sort());
    });
});

test('computeBlockLiveness read and write in one', t => {
    const block: BasicBlock = {
        name: 'test',
        instructions: [
            {
                kind: 'subtract',
                lhs: { name: 'r' },
                rhs: { name: 'd' },
                destination: { name: 'r' },
                why: 'r = r - d',
            },
            {
                kind: 'move',
                from: { name: 'r' },
                to: { name: 'v' },
                why: 'v = r',
            },
        ],
    };
    const liveness = computeBlockLiveness(block);
    const expected = [[{ name: 'r' }, { name: 'd' }], [{ name: 'r' }], []];
    t.deepEqual(liveness.length, expected.length);
    expected.forEach((e, i) => {
        t.deepEqual(e.sort(), liveness[i].toList().sort());
    });
});

test('liveness analysis basic test', t => {
    const testFunction: ThreeAddressFunction = {
        name: 'test',
        isMain: false,
        instructions: [
            {
                kind: 'add',
                lhs: { name: 'add_l' },
                rhs: { name: 'add_r' },
                destination: { name: 'add_d' },
                why: 'add_d = add_l + add_r',
            },
            {
                kind: 'gotoIfZero',
                register: { name: 'add_d' },
                label: 'L',
                why: 'if add_d == 0 goto L',
            },
            {
                kind: 'subtract',
                lhs: { name: 'sub_l' },
                rhs: { name: 'sub_r' },
                destination: { name: 'sub_d' },
                why: 'sub_d = sub_l = sub_r',
            },
            {
                kind: 'label',
                name: 'L',
                why: 'L',
            },
        ],
    };
    const testFunctionLiveness = tafLiveness(testFunction).map(s => s.toList());
    const expectedLiveness = [
        [{ name: 'add_l' }, { name: 'add_r' }, { name: 'sub_l' }, { name: 'sub_r' }],
        [{ name: 'add_d' }, { name: 'sub_l' }, { name: 'sub_r' }],
        [{ name: 'sub_l' }, { name: 'sub_r' }],
        [],
        [],
    ];
    t.deepEqual(testFunctionLiveness, expectedLiveness);
});

test('4 block graph (length)', t => {
    const lengthRTLF: ThreeAddressFunction = {
        name: 'length',
        isMain: false,
        instructions: [
            {
                kind: 'loadImmediate',
                destination: 'functionResult',
                value: 0,
                why: 'functionResult = 0',
            },
            { kind: 'label', name: 'length_loop', why: 'Count another charachter' },
            {
                kind: 'loadMemoryByte',
                address: 'functionArgument1',
                to: { name: 'currentChar' },
                why: 'currentChar = *functionArgument1',
            },
            {
                kind: 'gotoIfZero',
                register: { name: 'currentChar' },
                label: 'length_return',
                why: 'if currentChar == 0 goto length_return',
            },
            { kind: 'increment', register: 'functionResult', why: 'functionResult++' },
            { kind: 'increment', register: 'functionArgument1', why: 'functionArgument1++' },
            { kind: 'goto', label: 'length_loop', why: 'goto length_loop' },
            { kind: 'label', name: 'length_return', why: 'length_return:' },
            {
                kind: 'subtract',
                lhs: 'functionArgument1',
                rhs: 'functionResult',
                destination: 'functionArgument1',
                why: 'functionArgument1 = functionResult - functionArgument1',
            },
        ],
    };
    const lengthLiveness = tafLiveness(lengthRTLF).map(s =>
        s
            .toList()
            .map(r => {
                if (typeof r == 'string') return r;
                return r.name;
            })
            .sort()
    );
    const expectedLiveness = [
        ['functionArgument1'],
        ['functionArgument1', 'functionResult'],
        ['functionArgument1', 'functionResult'],
        ['currentChar', 'functionArgument1', 'functionResult'],
        ['functionArgument1', 'functionResult'],
        ['functionArgument1', 'functionResult'],
        ['functionArgument1', 'functionResult'],
        ['functionArgument1', 'functionResult'],
        ['functionArgument1', 'functionResult'],
        [],
    ];
    t.deepEqual(lengthLiveness, expectedLiveness);
});

test('liveness of stringEquality', t => {
    const complexFunction: ThreeAddressFunction = {
        name: 'complexFunction',
        isMain: false,
        instructions: [
            {
                kind: 'loadImmediate',
                destination: 'functionResult',
                value: 1,
                why: '',
            },
            {
                kind: 'label',
                name: 'loop',
                why: '',
            },
            {
                kind: 'loadImmediate',
                destination: 'functionResult',
                value: 1,
                why: '',
            },
            {
                kind: 'gotoIfNotEqual',
                lhs: { name: 'leftByte' },
                rhs: { name: 'rightByte' },
                label: 'return_false',
                why: '',
            },
            {
                kind: 'gotoIfZero',
                register: { name: 'leftByte' },
                label: 'return',
                why: '',
            },
            {
                kind: 'loadImmediate',
                destination: 'functionResult',
                value: 1,
                why: '',
            },
            {
                kind: 'goto',
                label: 'loop',
                why: '',
            },
            {
                kind: 'label',
                name: 'return_false',
                why: '',
            },
            {
                kind: 'loadImmediate',
                destination: 'functionResult',
                value: 1,
                why: '',
            },
            {
                kind: 'label',
                name: 'return',
                why: '',
            },
        ],
    };
    const liveness = tafLiveness(complexFunction).map(s =>
        s
            .toList()
            .map(r => {
                if (typeof r == 'string') return r;
                return r.name;
            })
            .sort()
    );

    const expectedLiveness = [
        ['leftByte', 'rightByte'],
        ['leftByte', 'rightByte'],
        ['leftByte', 'rightByte'],
        ['leftByte', 'rightByte'],
        ['leftByte', 'rightByte'],
        ['leftByte', 'rightByte'],
        ['leftByte', 'rightByte'],
        [],
        [],
        [],
        [],
    ];
    t.deepEqual(liveness, expectedLiveness);
});
