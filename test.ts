import testCases from './test-cases.js';
import parseTac from './threeAddressCode/parser.js';
import prettyParseError from './parser-lib/pretty-parse-error.js';
import { equal as typesAreEqual, builtinTypes, Type, TypeDeclaration } from './types.js';
import { ThreeAddressStatement, ThreeAddressFunction } from './threeAddressCode/generator.js';
import * as threeAddressCodeRuntime from './threeAddressCode/runtime.js';
import test from 'ava';
import flatten from './util/list/flatten.js';
import join from './util/join.js';
import { lex } from './parser-lib/lex.js';
import { parseMpl, compile, typeCheckStatement, astFromParseResult, typeOfExpression } from './frontend.js';
import { compileAndRun } from './test-utils.js';
import { grammar, tokenSpecs, MplParseResult, MplAst } from './grammar.js';
import { stripResultIndexes, ParseResult, parse, parseResultIsError, stripSourceLocation } from './parser-lib/parse.js';
import * as Ast from './ast.js';
import { removeBracketsFromAst } from './frontend.js';
import { controlFlowGraph, toDotFile, BasicBlock, computeBlockLiveness, tafLiveness } from './controlFlowGraph.js';
import debug from './util/debug.js';

test('double flatten', t => {
    t.deepEqual(flatten(flatten([[[1, 2]], [[3], [4]], [[5]]])), [1, 2, 3, 4, 5]);
});

test('lexer', t => {
    t.deepEqual(lex(tokenSpecs, '123'), [
        { type: 'number', value: 123, string: '123', sourceLocation: { line: 1, column: 1 } },
    ]);
    t.deepEqual(lex(tokenSpecs, '123 456'), [
        { type: 'number', value: 123, string: '123', sourceLocation: { line: 1, column: 1 } },
        { type: 'number', value: 456, string: '456', sourceLocation: { line: 1, column: 5 } },
    ]);
    t.deepEqual(lex(tokenSpecs, '&&&&&'), [
        { type: 'invalid', value: '&&&&&', string: '&&&&&', sourceLocation: { line: 1, column: 1 } },
    ]);
    t.deepEqual(lex(tokenSpecs, '(1)'), [
        { type: 'leftBracket', value: null, string: '(', sourceLocation: { line: 1, column: 1 } },
        { type: 'number', value: 1, string: '1', sourceLocation: { line: 1, column: 2 } },
        { type: 'rightBracket', value: null, string: ')', sourceLocation: { line: 1, column: 3 } },
    ]);
    t.deepEqual(lex(tokenSpecs, 'return 100'), [
        { type: 'return', value: null, string: 'return', sourceLocation: { line: 1, column: 1 } },
        { type: 'number', value: 100, string: '100', sourceLocation: { line: 1, column: 8 } },
    ]);
    t.deepEqual(lex(tokenSpecs, 'return "test string"'), [
        { type: 'return', value: null, string: 'return', sourceLocation: { line: 1, column: 1 } },
        { type: 'stringLiteral', value: 'test string', string: 'test string', sourceLocation: { line: 1, column: 8 } },
    ]);
});

test('lex with initial whitespace', t => {
    t.deepEqual(lex(tokenSpecs, ' 123'), [
        { type: 'number', value: 123, string: '123', sourceLocation: { line: 1, column: 2 } },
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
                sourceLocation: { line: 1, column: 1 },
                children: [
                    {
                        type: 'return',
                        value: null,
                        sourceLocation: { line: 1, column: 1 },
                    },
                    {
                        type: 'number',
                        value: 7,
                        sourceLocation: { line: 1, column: 8 },
                    },
                    {
                        type: 'statementSeparator',
                        value: null,
                        sourceLocation: { line: 1, column: 9 },
                    },
                ],
            },
            {
                type: 'endOfFile',
                value: 'endOfFile',
                sourceLocation: { line: 1, column: 10 },
            },
        ],
        sourceLocation: { line: 1, column: 1 },
    } as MplAst;
    t.deepEqual(expectedResult, parseResult);
});

test('ast for number in brackets', t => {
    t.deepEqual(
        removeBracketsFromAst(stripResultIndexes(parse(grammar, 'program', lex(tokenSpecs, ' return (5);'), 0))),
        {
            type: 'program',
            sourceLocation: { line: 1, column: 2 },
            children: [
                {
                    type: 'returnStatement',
                    sourceLocation: { line: 1, column: 2 },
                    children: [
                        {
                            type: 'return',
                            value: null,
                            sourceLocation: { line: 1, column: 2 },
                        },
                        {
                            type: 'number',
                            value: 5,
                            sourceLocation: { line: 1, column: 10 },
                        },
                        {
                            type: 'statementSeparator',
                            value: null,
                            sourceLocation: { line: 1, column: 12 },
                        },
                    ],
                },
                {
                    type: 'endOfFile',
                    value: 'endOfFile',
                    sourceLocation: { line: 1, column: 13 },
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
            sourceLocation: { line: 1, column: 1 },
            children: [
                {
                    type: 'returnStatement',
                    sourceLocation: { line: 1, column: 1 },
                    children: [
                        {
                            type: 'return',
                            value: null,
                            sourceLocation: { line: 1, column: 1 },
                        },
                        {
                            type: 'number',
                            value: 20,
                            sourceLocation: { line: 1, column: 10 },
                        },
                        {
                            type: 'statementSeparator',
                            value: null,
                            sourceLocation: { line: 1, column: 14 },
                        },
                    ],
                },
                {
                    type: 'endOfFile',
                    value: 'endOfFile',
                    sourceLocation: { line: 1, column: 15 },
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
            sourceLocation: { line: 1, column: 1 },
            children: [
                {
                    type: 'returnStatement',
                    sourceLocation: { line: 1, column: 1 },
                    children: [
                        {
                            type: 'return',
                            sourceLocation: { line: 1, column: 1 },
                            value: null,
                        },
                        {
                            type: 'product',
                            sourceLocation: { line: 1, column: 8 },
                            children: [
                                {
                                    type: 'number',
                                    value: 3,
                                    sourceLocation: { line: 1, column: 8 },
                                },
                                {
                                    type: 'product',
                                    value: null,
                                    sourceLocation: { line: 1, column: 10 },
                                },
                                {
                                    type: 'product',
                                    sourceLocation: { line: 1, column: 13 },
                                    children: [
                                        {
                                            type: 'number',
                                            value: 4,
                                            sourceLocation: { line: 1, column: 13 },
                                        },
                                        {
                                            type: 'product',
                                            value: null,
                                            sourceLocation: { line: 1, column: 15 },
                                        },
                                        {
                                            type: 'number',
                                            value: 5,
                                            sourceLocation: { line: 1, column: 17 },
                                        },
                                    ],
                                },
                            ],
                        },
                        {
                            type: 'statementSeparator',
                            value: null,
                            sourceLocation: { line: 1, column: 19 },
                        },
                    ],
                },
                {
                    type: 'endOfFile',
                    value: 'endOfFile',
                    sourceLocation: { line: 1, column: 20 },
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

test('correct inferred type for function', t => {
    const functionSource = 'a: Integer => 11';
    const parseResult: MplParseResult = parse(grammar, 'function', lex(tokenSpecs, functionSource), 0);
    const ast: Ast.UninferredExpression = astFromParseResult(parseResult as MplAst) as Ast.UninferredExpression;
    t.deepEqual(typeOfExpression({ w: ast, availableVariables: [], availableTypes: [] }), {
        type: {
            kind: 'Function',
            arguments: [{ kind: 'Integer' }, { kind: 'Integer' }],
        },
        extractedFunctions: [
            {
                name: 'anonymous_1', // TODO: Make this not dependent on test order
                parameters: [
                    {
                        name: 'a',
                        type: {
                            kind: 'Integer',
                        },
                    },
                ],
                returnType: {
                    kind: 'Integer',
                },
                statements: [
                    {
                        expression: {
                            kind: 'number',
                            sourceLocation: {
                                column: 15,
                                line: 1,
                            },
                            value: 11,
                        },
                        kind: 'returnStatement',
                        sourceLocation: {
                            column: 1,
                            line: 1,
                        },
                    },
                ],
                variables: [
                    {
                        name: 'a',
                        type: {
                            kind: 'Integer',
                        },
                    },
                ],
            },
        ],
    });
});

test('multiple variables called', compileAndRun, {
    source: `
const11 := a: Integer => 11;
const12 := a: Integer => 12;
return const11(1) * const12(2);`,
    exitCode: 132,
});

test('double product with brackets', compileAndRun, {
    source: 'return 2 * (3 * 4) * 5',
    exitCode: 120,
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

testCases.forEach(({ name, source, exitCode }) => {
    test(name, compileAndRun, { source, exitCode });
});

test('double product', compileAndRun, {
    source: 'return 5 * 3 * 4',
    exitCode: 60,
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

test('brackets product', compileAndRun, {
    source: 'return (3 * 4) * 5',
    exitCode: 60,
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

test('id function', compileAndRun, {
    source: 'id := a: Integer => a; return id(5)',
    exitCode: 5,
});

test('double function', compileAndRun, {
    source: 'doubleIt := a: Integer => 2 * a; return doubleIt(100)',
    exitCode: 200,
});

test('subtraction', compileAndRun, {
    source: 'return 7 - 5',
    exitCode: 2,
});

test('order of operations', compileAndRun, {
    source: 'return 2 * 5 - 1',
    exitCode: 9,
});

test('associativity of subtraction', compileAndRun, {
    source: 'return 5 - 2 - 1',
    exitCode: 2,
});

test('ternary true', compileAndRun, {
    source: 'return 1 == 1 ? 5 : 6',
    exitCode: 5,
});

test('ternary false', compileAndRun, {
    source: 'return 0 == 1 ? 5 : 6',
    exitCode: 6,
});

test('parse error', compileAndRun, {
    source: '=>',
    expectedParseErrors: [
        {
            kind: 'unexpectedToken',
            errors: [
                {
                    expected: 'identifier',
                    found: 'fatArrow',
                    sourceLocation: {
                        column: 1,
                        line: 1,
                    },
                },
                {
                    expected: 'identifier',
                    found: 'fatArrow',
                    sourceLocation: {
                        column: 1,
                        line: 1,
                    },
                },
                {
                    expected: 'typeIdentifier',
                    found: 'fatArrow',
                    sourceLocation: {
                        column: 1,
                        line: 1,
                    },
                },
                {
                    expected: 'identifier',
                    found: 'fatArrow',
                    sourceLocation: {
                        column: 1,
                        line: 1,
                    },
                },
                {
                    expected: 'return',
                    found: 'fatArrow',
                    sourceLocation: {
                        column: 1,
                        line: 1,
                    },
                },
            ],
        },
    ],
});

test('ternary in function false', compileAndRun, {
    source: `
ternary := a: Boolean => a ? 9 : 5;
return ternary(false);`,
    exitCode: 5,
});

test('ternary in function then subtract', compileAndRun, {
    source: `
ternaryFunc := a:Boolean => a ? 9 : 3;
return ternaryFunc(true) - ternaryFunc(false);`,
    exitCode: 6,
});

test('equality comparison true', compileAndRun, {
    source: `
isFive := five: Integer => five == 5 ? 2 : 7;
return isFive(5);`,
    exitCode: 2,
});

test('equality comparison false', compileAndRun, {
    source: `
isFive := notFive: Integer => notFive == 5 ? 2 : 7;
return isFive(11);`,
    exitCode: 7,
});

test('factorial', compileAndRun, {
    source: `
factorial := x: Integer => x == 1 ? 1 : x * factorial(x - 1);
return factorial(5);`,
    exitCode: 120,
});

test.failing('2 arg recursve', compileAndRun, {
    source: `
recursiveAdd := x: Integer, y: Integer => x == 0 ? y : recursiveAdd(x - 1, y + 1);
return recursiveAdd(4,11);`,
    exitCode: 15,
});

test.failing('uninferable recursive', compileAndRun, {
    source: `
recursive := x: Integer => recursive(x);
return recursive(1);`,
    exitCode: 15,
});

test('return bool fail', compileAndRun, {
    source: 'return 1 == 2',
    expectedTypeErrors: [
        {
            kind: 'wrongTypeReturn',
            expressionType: builtinTypes.Boolean,
            sourceLocation: { line: 1, column: 1 },
        },
    ],
});

test('boolean literal false', compileAndRun, {
    source: `return false ? 1 : 2`,
    exitCode: 2,
});

test('boolean literal true', compileAndRun, {
    source: `return true ? 1 : 2`,
    exitCode: 1,
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
            sourceLocation: { line: 3, column: 8 },
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
            sourceLocation: { line: 1, column: 1 },
        },
    ],
});

test('assign function to typed var', compileAndRun, {
    source: 'myFunc: Function<Integer, Integer> = a: Integer => a; return myFunc(37);',
    exitCode: 37,
});

test('assign function with multiple args to typed var', compileAndRun, {
    source: `
myFunc: Function<Integer, String, Integer> = (a: Integer, b: String) => a + length(b);
return myFunc(4, "four");`,
    exitCode: 8,
});

test('assign function with no args to typed var', compileAndRun, {
    source: `
myFunc: Function<Integer> = () => 111;
return myFunc();`,
    exitCode: 111,
});

test('assign function to wrong args number', compileAndRun, {
    source: `
myFunc: Function<Integer, Integer> = () => 111;
return 0;`,
    expectedTypeErrors: [
        {
            kind: 'assignWrongType',
            lhsName: 'myFunc',
            lhsType: {
                kind: 'Function',
                arguments: [builtinTypes.Integer, builtinTypes.Integer],
            },
            rhsType: {
                kind: 'Function',
                arguments: [builtinTypes.Integer],
            },
            sourceLocation: { line: 2, column: 1 },
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
                kind: 'Function',
                arguments: [builtinTypes.Integer, builtinTypes.Integer],
            },
            rhsType: {
                kind: 'Function',
                arguments: [builtinTypes.String, builtinTypes.Integer],
            },
            sourceLocation: { line: 2, column: 1 },
        },
    ],
});

test('return boolean', compileAndRun, {
    source: `
isFive: Function<Integer, Boolean> = a: Integer => a == 5;
return isFive(5) ? 1 : 0`,
    exitCode: 1,
});

test('return string', compileAndRun, {
    source: `
isFive: Function<Integer, String> = a: Integer => a == 5 ? "isFive" : "isNotFive";
return length(isFive(5))`,
    exitCode: 6,
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
                kind: 'Function',
                arguments: [builtinTypes.Integer, builtinTypes.Boolean],
            },
            rhsType: {
                kind: 'Function',
                arguments: [builtinTypes.String, builtinTypes.Integer],
            },
            sourceLocation: { line: 2, column: 1 },
        },
    ],
});

test('return local integer', compileAndRun, {
    source: 'myVar: Integer = 3 * 3; return myVar',
    exitCode: 9,
});

// Need spilling
test.failing('many temporaries, spill to ram', compileAndRun, {
    source: 'return 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1',
    exitCode: 1,
});

test('multi statement function with locals', compileAndRun, {
    source: `
quadrupleWithLocal := a: Integer => { b: Integer = 2 * a; return 2 * b; };
return quadrupleWithLocal(5);`,
    exitCode: 20,
});

test('multi statement function with type error', compileAndRun, {
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
            sourceLocation: { line: 2, column: 60 },
        },
        // TODO: Refactor until I don't get the same error twice
        {
            kind: 'wrongTypeForOperator',
            operator: 'product',
            side: 'right',
            found: builtinTypes.Boolean,
            expected: 'Integer',
            sourceLocation: { line: 2, column: 60 },
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
    exitCode: 20,
});

test('string length', compileAndRun, {
    source: `myStr: String = "test"; return length(myStr);`,
    exitCode: 4,
});

test('empty string length', compileAndRun, {
    source: `myStr: String = ""; return length(myStr);`,
    exitCode: 0,
});

test('string length with type inferred', compileAndRun, {
    source: `myStr := "test2"; return length(myStr);`,
    exitCode: 5,
});

test('structure is equal for inferred string type', t => {
    const inferredStructure = compile('myStr := "test"; return length(myStr);');
    const suppliedStructure = compile('myStr: String = "test"; return length(myStr);');
    // TODO:  remove this awful hack. Need to either strip source location from structure,
    // or not have it there in the first place.
    (inferredStructure as any).program.statements[0].expression.sourceLocation.column = 17;
    (inferredStructure as any).program.statements[1].expression.arguments[0].sourceLocation.column = 39;
    (inferredStructure as any).program.statements[1].expression.sourceLocation.column = 32;
    (inferredStructure as any).program.statements[1].sourceLocation.column = 25;
    t.deepEqual(inferredStructure, suppliedStructure);
});

test('string copy', compileAndRun, {
    source: `myStr1: String = "testing"; myStr2: String = myStr1; return length(myStr2);`,
    exitCode: 7,
});

test('string equality: equal', compileAndRun, {
    source: `str1 := "a";
str2 := "a";
return str1 == str2 ? 1 : 2;
`,
    exitCode: 1,
});

test('string equality: inequal same length', compileAndRun, {
    source: `str1 := "a";
str2 := "b";
return str1 == str2 ? 1 : 2;
`,
    exitCode: 2,
});

test('string equality: inequal different length', compileAndRun, {
    source: `str1 := "aa";
str2 := "a";
return str1 == str2 ? 7 : 2;
`,
    exitCode: 2,
});

test('wrong type global', compileAndRun, {
    source: `str: String = 5; return length(str);`,
    expectedTypeErrors: [
        {
            kind: 'assignWrongType',
            lhsName: 'str',
            lhsType: builtinTypes.String,
            rhsType: builtinTypes.Integer,
            sourceLocation: { line: 1, column: 1 },
        },
    ],
});

test('concatenate and get length then subtract', compileAndRun, {
    source: `return length("abc" ++ "defg") - 2;`,
    exitCode: 5,
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
    exitCode: 6,
});

test('parsing fails for extra invalid tokens', compileAndRun, {
    source: `return 5 (`,
    expectedParseErrors: [
        {
            errors: [
                {
                    found: 'leftBracket',
                    expected: 'endOfFile',
                    sourceLocation: { line: 1, column: 10 },
                },
            ],
            kind: 'unexpectedToken',
        },
    ],
});

test('addition', compileAndRun, {
    source: `return length("foo") + 5;`,
    exitCode: 8,
});

test('two args', compileAndRun, {
    source: `
myAdd := a: Integer, b: Integer => a + b;
return myAdd(7, 4);`,
    exitCode: 11,
});

test('two args with expression argument', compileAndRun, {
    source: `
myAdd := a: Integer, b: Integer => a + b;
return myAdd(7 + 7, 4);`,
    exitCode: 18,
});

test('three args', compileAndRun, {
    source: `
myAdd := a: Integer, b: Integer, c: Integer => a + b + c;
return myAdd(7, 4, 5);`,
    exitCode: 16,
});

test('zero args', compileAndRun, {
    source: `
const11 := () => 11;
return const11();`,
    exitCode: 11,
});

test('one bracketed arg', compileAndRun, {
    source: `
times11 := (a: Integer) => a * 11;
return times11(1);`,
    exitCode: 11,
});

test('two bracketed args', compileAndRun, {
    source: `
timess := (a: Integer, b: Integer) => a * b;
return timess(11, 1);`,
    exitCode: 11,
});

test('function named times', compileAndRun, {
    source: `
times := (a: Integer, b: Integer) => a * b;
return times(11, 1);`,
    exitCode: 11,
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
            sourceLocation: { line: 3, column: 8 },
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
            sourceLocation: { line: 3, column: 8 },
        },
    ],
});

test('print', compileAndRun, {
    source: `
dummy := print("sample_string");
return 1;`,
    exitCode: 1,
    expectedStdOut: 'sample_string',
});

test('print string with space', compileAndRun, {
    source: `
dummy := print("sample string with space");
return 1;`,
    exitCode: 1,
    expectedStdOut: 'sample string with space',
});

test.failing('require/force no return value for print', compileAndRun, {
    source: `
print("sample string");
return 1;`,
    exitCode: 1,
    expectedStdOut: 'sample string',
});

test('print string containing number', compileAndRun, {
    source: `
dummy := print("1");
return 1 + dummy - dummy;`,
    exitCode: 1,
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
    exitCode: 3,
});

test('string args', compileAndRun, {
    source: `
excitmentifier := (boring: String) => {
    dummy := print(boring ++ "!");
    return 11 + dummy - dummy;
};
return excitmentifier("Hello World");`,
    expectedStdOut: 'Hello World!',
    exitCode: 11,
});

test('reassign integer', compileAndRun, {
    source: `
a := 1;
bb := a + 5;
a = 2;
c := a + bb;
return c;`,
    exitCode: 8,
});

test('reassign to undeclared identifier', compileAndRun, {
    source: `
a := 1;
b = 2;
return a + b;`,
    expectedTypeErrors: [
        { kind: 'assignUndeclaredIdentifer', destinationName: 'b', sourceLocation: { line: 3, column: 1 } },
    ],
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
            sourceLocation: { line: 3, column: 1 },
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
    exitCode: 0,
    expectedStdOut: 'HelloWorld!!!!!',
});

test('reassign to a using expression including a', compileAndRun, {
    source: `
hello := "HelloWorld";
hello = hello ++ "!";
return length(hello);`,
    exitCode: 11,
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
    exitCode: 8,
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
            sourceLocation: { line: 4, column: 5 },
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
            sourceLocation: { line: 4, column: 5 },
        },
    ],
});

test('reassign string inside function', compileAndRun, {
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
    exitCode: 0,
    expectedStdOut: 'HelloWorld!!!!!',
});

test('variable named b', compileAndRun, {
    source: `
b := 2;
return b;`,
    exitCode: 2,
});

test('bool pair', compileAndRun, {
    source: `
BoolPair := {
    first: Boolean;
    second: Boolean;
};
bp: BoolPair = BoolPair { first: true, second: false, };
return bp.first ? 10 : 20;
`,
    exitCode: 10,
});

test('int pair', compileAndRun, {
    source: `
IntPair := {
    first: Integer;
    second: Integer;
};
ip: IntPair = IntPair { first: 3, second: 7, };
return ip.first * ip.second;
`,
    exitCode: 21,
});

test('int pair in function', compileAndRun, {
    source: `
IntPair := {
    first: Integer;
    second: Integer;
};

foo := () => {
    ip := IntPair {
        first: 12,
        second: 34,
    };

    return ip.second - ip.first;
};

return foo();`,
    exitCode: 34 - 12,
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

test('type equality', t => {
    t.false(
        typesAreEqual(
            {
                kind: 'Function',
                arguments: [{ kind: 'Integer' }],
            },
            {
                kind: 'Function',
                arguments: [{ kind: 'Integer' }, { kind: 'Integer' }, { kind: 'Integer' }],
            },
            []
        )
    );
});

test('type of objectLiteral', t => {
    const ast: Ast.UninferredExpression = {
        kind: 'objectLiteral',
        typeName: 'BoolPair',
        members: [
            {
                name: 'first',
                expression: { kind: 'booleanLiteral', value: true, sourceLocation: { line: 6, column: 34 } },
            },
            {
                name: 'second',
                expression: { kind: 'booleanLiteral', value: false, sourceLocation: { line: 6, column: 48 } },
            },
        ],
        sourceLocation: { line: 6, column: 16 },
    };
    const type = typeOfExpression({
        w: ast,
        availableVariables: [],
        availableTypes: [
            {
                name: 'BoolPair',
                type: {
                    kind: 'Product',
                    name: 'BoolPair',
                    members: [
                        { name: 'first', type: { kind: 'Boolean' } },
                        { name: 'second', type: { kind: 'Boolean' } },
                    ],
                },
            },
        ],
    });
    const expectedType = {
        type: {
            kind: 'Product',
            name: 'BoolPair',
            members: [{ name: 'first', type: { kind: 'Boolean' } }, { name: 'second', type: { kind: 'Boolean' } }],
        },
        extractedFunctions: [],
    };
    t.deepEqual(type, expectedType as any);
});

test('type equality via name lookup', t => {
    const leftType: Type = {
        kind: 'Product',
        name: 'BoolPair',
        members: [{ name: 'first', type: { kind: 'Boolean' } }, { name: 'second', type: { kind: 'Boolean' } }],
    };
    const rightType: Type = {
        kind: 'NameRef',
        namedType: 'BoolPair',
    };
    const typeDeclarations: TypeDeclaration[] = [{ name: 'BoolPair', type: leftType }];
    t.deepEqual(typesAreEqual(leftType, rightType as any, typeDeclarations), true);
});

test('pretty-parse-error', t => {
    // nominal test
    t.deepEqual(
        prettyParseError('contextBefore\n123456789\ncontextAfter', { line: 2, column: 4 }, 'message'),
        'contextBefore\n123456789\n   ^ message at line 2 column 4\ncontextAfter'
    );

    // line out of range too low
    t.deepEqual(prettyParseError('contextBefore\n123456789\ncontextAfter', { line: 0, column: 4 }, ''), null);
    // line out of range too high
    t.deepEqual(prettyParseError('contextBefore\n123456789\ncontextAfter', { line: 4, column: 4 }, ''), null);
    // column out of range too low
    t.deepEqual(prettyParseError('contextBefore\n123456789\ncontextAfter', { line: 2, column: 0 }, ''), null);
    // column out of range too high
    t.deepEqual(prettyParseError('contextBefore\n123456789\ncontextAfter', { line: 2, column: 10 }, ''), null);

    // First line
    t.deepEqual(
        prettyParseError('123456789\ncontextAfter', { line: 1, column: 1 }, 'm'),
        '123456789\n^ m at line 1 column 1\ncontextAfter'
    );
    // Last line
    t.deepEqual(
        prettyParseError('contextBefore\n123456789', { line: 2, column: 9 }, 'm2'),
        'contextBefore\n123456789\n        ^ m2 at line 2 column 9'
    );
    // Only line
    t.deepEqual(prettyParseError('123456789', { line: 1, column: 1 }, 'm3'), '123456789\n^ m3 at line 1 column 1');
});

test('tac parser regression', t => {
    const source = `(global) id: id_1 17
(global) id: id_1 17
(function) length:
r:functionResult = 0 # Set length count to 0
(function) stringEquality:
r:functionResult = 1 # Assume equal. Write true to functionResult. Overwrite if difference found.
`;

    const result = parseTac(source);
    if (Array.isArray(result)) {
        t.fail(
            join(
                result.map(e => {
                    if (typeof e === 'string') {
                        return e;
                    } else {
                        return (
                            prettyParseError(source, e.sourceLocation, `found ${e.found}, expected ${e.expected}`) || ''
                        );
                    }
                }),
                '\n\n'
            )
        );
    }
    t.deepEqual(Array.isArray(result), false);
});
