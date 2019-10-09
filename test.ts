import testCases from './test-cases.js';
import { parseProgram as parseTacProgram, parseInstructions } from './threeAddressCode/parser.js';
import annontateSource from './annotateSource.js';
import { equal as typesAreEqual, builtinTypes, Type, TypeDeclaration } from './types.js';
import { ThreeAddressFunction } from './threeAddressCode/generator.js';
import { Statement } from './threeAddressCode/statement.js';
import * as threeAddressCodeRuntime from './threeAddressCode/runtime.js';
import test from 'ava';
import flatten from './util/list/flatten.js';
import join from './util/join.js';
import range from './util/list/range.js';
import { lex, Token } from './parser-lib/lex.js';
import { parseMpl, compile, astFromParseResult, typeOfExpression } from './frontend.js';
import { mplTest, tacTest } from './test-utils.js';
import { grammar, tokenSpecs, MplParseResult, MplAst, MplToken } from './grammar.js';
import {
    stripResultIndexes,
    parse,
    parseResultIsError,
    stripSourceLocation,
    Terminal,
    Optional,
    Grammar,
    Sequence,
} from './parser-lib/parse.js';
import * as Ast from './ast.js';
import { removeBracketsFromAst } from './frontend.js';
import {
    assignRegisters,
    controlFlowGraph,
    BasicBlock,
    computeBlockLiveness,
    tafLiveness,
} from './controlFlowGraph.js';
import { orderedSet, operatorCompare } from './util/ordered-set.js';
import { set } from './util/set.js';
import { shuffle } from 'shuffle-seed';

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
    t.deepEqual(lex(tokenSpecs, '&&&&&'), { kind: 'lexError', error: 'Invalid token: &&&&&' });
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
    const tokens = lex(tokenSpecs, 'return 7;') as Token<MplToken>[];
    const parseResult = stripResultIndexes(parse(grammar, 'program', tokens));
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
        ],
        sourceLocation: { line: 1, column: 1 },
    } as MplAst;
    t.deepEqual(expectedResult, parseResult);
});

test('ast for number in brackets', t => {
    t.deepEqual(
        removeBracketsFromAst(
            stripResultIndexes(parse(grammar, 'program', lex(tokenSpecs, ' return (5);') as Token<MplToken>[]))
        ),
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
            ],
        }
    );
});

test('ast for number in double brackets', t => {
    t.deepEqual(
        removeBracketsFromAst(
            stripResultIndexes(parse(grammar, 'program', lex(tokenSpecs, 'return ((20));') as Token<MplToken>[]))
        ),
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
            ],
        }
    );
});

test('ast for product with brackets', t => {
    t.deepEqual(
        removeBracketsFromAst(
            stripResultIndexes(parse(grammar, 'program', lex(tokenSpecs, 'return 3 * (4 * 5);') as Token<MplToken>[]))
        ),
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
        ],
    };
    const astWithSemicolon = stripSourceLocation(
        removeBracketsFromAst(
            stripResultIndexes(
                parse(grammar, 'program', lex(tokenSpecs, 'constThree := a: Integer => 3; return 10;') as Token<
                    MplToken
                >[])
            )
        )
    );
    t.deepEqual(astWithSemicolon, expected);
});

test('lowering of bracketedExpressions', t => {
    const lexResult = lex(tokenSpecs, 'return (8 * ((7)))') as Token<MplToken>[];
    t.deepEqual(stripSourceLocation(parseMpl(lexResult)), {
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
        ],
    });
});

test('correct inferred type for function', t => {
    const functionSource = 'a: Integer => 11';
    const parseResult: MplParseResult = parse(grammar, 'function', lex(tokenSpecs, functionSource) as Token<
        MplToken
    >[]);
    const ast: Ast.UninferredExpression = astFromParseResult(parseResult as MplAst) as Ast.UninferredExpression;
    t.deepEqual(typeOfExpression({ w: ast, availableVariables: [], availableTypes: [] }), {
        type: { kind: 'Function', arguments: [{ kind: 'Integer' }], permissions: [], returnType: { kind: 'Integer' } },
        extractedFunctions: [
            {
                name: 'anonymous_1', // TODO: Make this not dependent on test order
                parameters: [{ name: 'a', type: { kind: 'Integer' } }],
                returnType: { kind: 'Integer' },
                statements: [
                    {
                        expression: {
                            kind: 'number',
                            sourceLocation: { column: 15, line: 1 },
                            value: 11,
                        },
                        kind: 'returnStatement',
                        sourceLocation: { column: 1, line: 1 },
                    },
                ],
                variables: [{ name: 'a', type: { kind: 'Integer' } }],
            },
        ],
    });
});

testCases.forEach(({ name, source, exitCode, stdin, stdout, ast, parseErrors, failing, only }) => {
    const runner = failing ? test.failing : only ? test.only : test;
    runner(name, mplTest, {
        source,
        exitCode,
        name,
        stdin,
        expectedStdOut: stdout,
        expectedParseErrors: parseErrors,
        expectedAst: ast,
    });
});

test('double product', mplTest, {
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
        ],
    },
});

test('brackets product', mplTest, {
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
        ],
    },
});

test('double function', mplTest, {
    source: 'doubleIt := a: Integer => 2 * a; return doubleIt(100)',
    exitCode: 200,
});

test('subtraction', mplTest, {
    source: 'return 7 - 5',
    exitCode: 2,
});

test('order of operations', mplTest, {
    source: 'return 2 * 5 - 1',
    exitCode: 9,
});

test('associativity of subtraction', mplTest, {
    source: 'return 5 - 2 - 1',
    exitCode: 2,
});

test('ternary true', mplTest, {
    source: 'return 1 == 1 ? 5 : 6',
    exitCode: 5,
});

test('parse error', mplTest, {
    source: '=>',
    expectedParseErrors: [{ expected: 'identifier', found: 'fatArrow', sourceLocation: { column: 0, line: 0 } }],
});

test('ternary in function false', mplTest, {
    source: `
ternary := a: Boolean => a ? 9 : 5;
return ternary(false);`,
    exitCode: 5,
});

test('ternary in function then subtract', mplTest, {
    source: `
ternaryFunc := a:Boolean => a ? 9 : 3;
return ternaryFunc(true) - ternaryFunc(false);`,
    exitCode: 6,
});

test('equality comparison true', mplTest, {
    source: `
isFive := five: Integer => five == 5 ? 2 : 7;
return isFive(5);`,
    exitCode: 2,
});

test('equality comparison false', mplTest, {
    source: `
isFive := notFive: Integer => notFive == 5 ? 2 : 7;
return isFive(11);`,
    exitCode: 7,
});

test.failing('2 arg recursve', mplTest, {
    source: `
recursiveAdd := x: Integer, y: Integer => x == 0 ? y : recursiveAdd(x - 1, y + 1);
return recursiveAdd(4,11);`,
    exitCode: 15,
});

test.failing('uninferable recursive', mplTest, {
    source: `
recursive := x: Integer => recursive(x);
return recursive(1);`,
    exitCode: 15,
});

test('return bool fail', mplTest, {
    source: 'return 1 == 2',
    expectedTypeErrors: [
        {
            kind: 'wrongTypeReturn',
            expressionType: builtinTypes.Boolean,
            sourceLocation: { line: 1, column: 1 },
        },
    ],
});

test('boolean literal false', mplTest, {
    source: `return false ? 1 : 2`,
    exitCode: 2,
});

test('boolean literal true', mplTest, {
    source: `return true ? 1 : 2`,
    exitCode: 1,
});

test('wrong type for arg', mplTest, {
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

test('assign wrong type', mplTest, {
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

test('assign function to typed var', mplTest, {
    source: 'myFunc: Function<Integer, Integer> = a: Integer => a; return myFunc(37);',
    exitCode: 37,
});

test('assign function with multiple args to typed var', mplTest, {
    source: `
myFunc: Function<Integer, String, Integer> = (a: Integer, b: String) => a + length(b);
return myFunc(4, "four");`,
    exitCode: 8,
});

test('assign function with no args to typed var', mplTest, {
    source: `
myFunc: Function<Integer> = () => 111;
return myFunc();`,
    exitCode: 111,
});

test('assign function to wrong args number', mplTest, {
    source: `
myFunc: Function<Integer, Integer> = () => 111;
return 0;`,
    expectedTypeErrors: [
        {
            kind: 'assignWrongType',
            lhsName: 'myFunc',
            lhsType: {
                kind: 'Function',
                arguments: [builtinTypes.Integer],
                returnType: builtinTypes.Integer,
            },
            rhsType: { kind: 'Function', arguments: [], permissions: [], returnType: builtinTypes.Integer },
            sourceLocation: { line: 2, column: 1 },
        },
    ],
});

test('assign function to wrong args type', mplTest, {
    source: `
myFunc: Function<Integer, Integer> = (a: String) => 111;
return myFunc("");`,
    expectedTypeErrors: [
        {
            kind: 'assignWrongType',
            lhsName: 'myFunc',
            lhsType: {
                kind: 'Function',
                arguments: [builtinTypes.Integer],
                returnType: builtinTypes.Integer,
            },
            rhsType: {
                kind: 'Function',
                arguments: [builtinTypes.String],
                permissions: [],
                returnType: builtinTypes.Integer,
            },
            sourceLocation: { line: 2, column: 1 },
        },
    ],
});

test('return string', mplTest, {
    source: `
isFive: Function<Integer, String> = a: Integer => a == 5 ? "isFive" : "isNotFive";
return length(isFive(5))`,
    exitCode: 6,
});

test('assign function to wrong return type', mplTest, {
    source: `
myFunc: Function<Integer, Boolean> = (a: String) => 111;
return myFunc("");`,
    expectedTypeErrors: [
        {
            kind: 'assignWrongType',
            lhsName: 'myFunc',
            lhsType: {
                kind: 'Function',
                arguments: [builtinTypes.Integer],
                returnType: builtinTypes.Boolean,
            },
            rhsType: {
                kind: 'Function',
                arguments: [builtinTypes.String],
                permissions: [],
                returnType: builtinTypes.Integer,
            },
            sourceLocation: { line: 2, column: 1 },
        },
    ],
});

test('return local integer', mplTest, {
    source: 'myVar: Integer = 3 * 3; return myVar',
    exitCode: 9,
});

test.failing('many temporaries, spill to ram', mplTest, {
    source: 'return 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1',
    exitCode: 1,
});

test('multi statement function with locals', mplTest, {
    source: `
quadrupleWithLocal := a: Integer => { b: Integer = 2 * a; return 2 * b; };
return quadrupleWithLocal(5);`,
    exitCode: 20,
});

test('multi statement function with type error', mplTest, {
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

test('multi statement function on multiple lines', mplTest, {
    source: `
quadrupleWithLocal := a: Integer => {
    b: Integer = 2 * a;
    return 2 * b;
};

return quadrupleWithLocal(5);`,
    exitCode: 20,
});

test('string length with type inferred', mplTest, {
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

test('string equality: inequal same length', mplTest, {
    source: `str1 := "a";
str2 := "b";
return str1 == str2 ? 1 : 2;
`,
    exitCode: 2,
});

test('string equality: inequal different length', mplTest, {
    source: `str1 := "aa";
str2 := "a";
return str1 == str2 ? 7 : 2;
`,
    exitCode: 2,
});

test('wrong type global', mplTest, {
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

test('concatenate and get length then subtract', mplTest, {
    source: `return length("abc" ++ "defg") - 2;`,
    exitCode: 5,
});

test('parsing fails for extra invalid tokens', mplTest, {
    source: `return 5 (`,
    expectedParseErrors: [
        {
            found: 'leftBracket',
            expected: 'endOfFile',
            sourceLocation: { line: 1, column: 10 },
        },
    ],
});

test('addition', mplTest, {
    source: `return length("foo") + 5;`,
    exitCode: 8,
});

test('two args', mplTest, {
    source: `
myAdd := a: Integer, b: Integer => a + b;
return myAdd(7, 4);`,
    exitCode: 11,
});

test('two args with expression argument', mplTest, {
    source: `
myAdd := a: Integer, b: Integer => a + b;
return myAdd(7 + 7, 4);`,
    exitCode: 18,
});

test('three args', mplTest, {
    source: `
myAdd := a: Integer, b: Integer, c: Integer => a + b + c;
return myAdd(7, 4, 5);`,
    exitCode: 16,
});

test('one bracketed arg', mplTest, {
    source: `
times11 := (a: Integer) => a * 11;
return times11(1);`,
    exitCode: 11,
});

test('two bracketed args', mplTest, {
    source: `
timess := (a: Integer, b: Integer) => a * b;
return timess(11, 1);`,
    exitCode: 11,
});

test('function named times', mplTest, {
    source: `
times := (a: Integer, b: Integer) => a * b;
return times(11, 1);`,
    exitCode: 11,
});

test('call with wrong number of args', mplTest, {
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

test('call with wrong arg type', mplTest, {
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

test('print string with space', mplTest, {
    source: `
dummy := print("sample string with space");
return 1;`,
    exitCode: 1,
    expectedStdOut: 'sample string with space',
});

test.failing('require/force no return value for print', mplTest, {
    source: `
print("sample string");
return 1;`,
    exitCode: 1,
    expectedStdOut: 'sample string',
});

test('print string containing number', mplTest, {
    source: `
dummy := print("1");
return 1 + dummy - dummy;`,
    exitCode: 1,
    expectedStdOut: '1',
    // Fails mips because of the silly way we extract exit codes.
    failing: ['mips'],
});

test('assign result of call to builtin to local in function', mplTest, {
    source: `
lengthOfFoo := (dummy: Integer) => {
    dumme := length("foo");
    return dumme;
};
return lengthOfFoo(1);`,
    exitCode: 3,
});

test('string args', mplTest, {
    source: `
excitmentifier := (boring: String) => {
    dummy := print(boring ++ "!");
    return 11 + dummy - dummy;
};
return excitmentifier("Hello World");`,
    expectedStdOut: 'Hello World!',
    exitCode: 11,
});

test('reassign integer', mplTest, {
    source: `
a := 1;
bb := a + 5;
a = 2;
c := a + bb;
return c;`,
    exitCode: 8,
});

test('reassign to undeclared identifier', mplTest, {
    source: `
a := 1;
b = 2;
return a + b;`,
    expectedTypeErrors: [
        { kind: 'assignUndeclaredIdentifer', destinationName: 'b', sourceLocation: { line: 3, column: 1 } },
    ],
});

test('reassigning wrong type', mplTest, {
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

test('reassign to a using expression including a', mplTest, {
    source: `
hello := "HelloWorld";
hello = hello ++ "!";
return length(hello);`,
    exitCode: 11,
});

test('reassign integer inside function', mplTest, {
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

test('reassign to undeclared identifier inside function', mplTest, {
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

test('reassigning wrong type inside function', mplTest, {
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

test('variable named b', mplTest, {
    source: `
b := 2;
return b;`,
    exitCode: 2,
});

test('bool pair', mplTest, {
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

test('controlFlowGraph basic test', t => {
    const rtl: Statement[] = [
        {
            kind: 'functionLabel',
            name: 'test',
            why: 'test',
        },
        {
            kind: 'return',
            register: { name: 'result' },
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
        instructions: parseInstructions(`
            r:d = r:l + r:r;
            r:r = r:l2 - r:d;
            r:v = r:l; dead
            r:v = r:r;
        `) as Statement[],
    };
    const liveness = computeBlockLiveness(block, []).map(l => l.toList().sort());
    const expected = [
        [{ name: 'l' }, { name: 'l2' }, { name: 'r' }],
        [{ name: 'l' }, { name: 'l2' }, { name: 'd' }],
        [{ name: 'r' }, { name: 'l' }],
        [{ name: 'r' }],
        [],
    ].map(e => e.sort());
    t.deepEqual(liveness, expected);
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
    const liveness = computeBlockLiveness(block, []);
    const expected = [[{ name: 'r' }, { name: 'd' }], [{ name: 'r' }], []];
    t.deepEqual(liveness.length, expected.length);
    expected.forEach((e, i) => {
        t.deepEqual(e.sort(), liveness[i].toList().sort());
    });
});

test('liveness analysis basic test', t => {
    const testFunction: ThreeAddressFunction = {
        name: 'test',
        spills: 0,
        liveAtExit: [],
        arguments: [{ name: 'some_arg' }],
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
        [{ name: 'add_l' }, { name: 'add_r' }, { name: 'sub_l' }, { name: 'sub_r' }, { name: 'some_arg' }],
        [{ name: 'add_d' }, { name: 'sub_l' }, { name: 'sub_r' }, { name: 'some_arg' }],
        [{ name: 'sub_l' }, { name: 'sub_r' }, { name: 'some_arg' }],
        [{ name: 'some_arg' }],
        [],
    ];
    t.deepEqual(testFunctionLiveness, expectedLiveness);
});

test('4 block graph (length)', t => {
    const lengthRTLF: ThreeAddressFunction = {
        name: 'length',
        spills: 0,
        liveAtExit: [],
        arguments: [{ name: 'strPtr' }],
        instructions: [
            {
                kind: 'loadImmediate',
                destination: { name: 'result' },
                value: 0,
                why: 'result = 0',
            },
            { kind: 'label', name: 'length_loop', why: 'Count another charachter' },
            {
                kind: 'loadMemoryByte',
                address: { name: 'strPtr' },
                to: { name: 'currentChar' },
                why: 'currentChar = *ptr',
            },
            {
                kind: 'gotoIfZero',
                register: { name: 'currentChar' },
                label: 'length_return',
                why: 'if currentChar == 0 goto length_return',
            },
            { kind: 'increment', register: { name: 'result' }, why: 'result++' },
            { kind: 'increment', register: { name: 'strPtr' }, why: 'arg1++' },
            { kind: 'goto', label: 'length_loop', why: 'goto length_loop' },
            { kind: 'label', name: 'length_return', why: 'length_return:' },
            {
                kind: 'subtract',
                lhs: { name: 'strPtr' },
                rhs: { name: 'result' },
                destination: { name: 'strPtr' },
                why: 'arg1 = result - arg1',
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
        ['strPtr'],
        ['result', 'strPtr'],
        ['result', 'strPtr'],
        ['currentChar', 'result', 'strPtr'],
        ['result', 'strPtr'],
        ['result', 'strPtr'],
        ['result', 'strPtr'],
        ['result', 'strPtr'],
        ['result', 'strPtr'],
        [],
    ];
    t.deepEqual(lengthLiveness, expectedLiveness);
});

test('liveness of stringEquality', t => {
    const complexFunction: ThreeAddressFunction = {
        name: 'complexFunction',
        spills: 0,
        liveAtExit: [],
        arguments: [],
        instructions: [
            {
                kind: 'loadImmediate',
                destination: { name: 'result' },
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
                destination: { name: 'result' },
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
                destination: { name: 'result' },
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
                destination: { name: 'result' },
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
                arguments: [],
                permissions: [],
                returnType: { kind: 'Integer' },
            },
            {
                kind: 'Function',
                arguments: [{ kind: 'Integer' }, { kind: 'Integer' }],
                permissions: [],
                returnType: { kind: 'Integer' },
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
        annontateSource('contextBefore\n123456789\ncontextAfter', { line: 2, column: 4 }, 'message'),
        'contextBefore\n123456789\n   ^ message\ncontextAfter'
    );

    // line out of range too low
    t.deepEqual(annontateSource('contextBefore\n123456789\ncontextAfter', { line: 0, column: 4 }, ''), null);
    // line out of range too high
    t.deepEqual(annontateSource('contextBefore\n123456789\ncontextAfter', { line: 4, column: 4 }, ''), null);
    // column out of range too low
    t.deepEqual(annontateSource('contextBefore\n123456789\ncontextAfter', { line: 2, column: 0 }, ''), null);

    // annotation is past line length
    t.deepEqual(
        annontateSource('contextBefore\n123456789\ncontextAfter', { line: 2, column: 10 }, ''),
        'contextBefore\n123456789\n         ^ \ncontextAfter'
    );

    // First line
    t.deepEqual(
        annontateSource('123456789\ncontextAfter', { line: 1, column: 1 }, 'm'),
        '123456789\n^ m\ncontextAfter'
    );
    // Last line
    t.deepEqual(
        annontateSource('contextBefore\n123456789', { line: 2, column: 9 }, 'm2'),
        'contextBefore\n123456789\n        ^ m2'
    );
    // Only line
    t.deepEqual(annontateSource('123456789', { line: 1, column: 1 }, 'm3'), '123456789\n^ m3');
});

test('tac parser regression', t => {
    const source = `(global) id: id_1 17
(global) id: id_1 17
(function) length():
    r:result = 0; Comment
(function) stringEquality():
    r:result = 1; Comment
`;

    const result = parseTacProgram(source);
    if (Array.isArray(result)) {
        t.fail(
            join(
                result.map(e => {
                    if (typeof e === 'string') {
                        return e;
                    } else {
                        return (
                            annontateSource(source, e.sourceLocation, `found ${e.found}, expected ${e.expected}`) || ''
                        );
                    }
                }),
                '\n\n'
            )
        );
    }
    t.deepEqual(Array.isArray(result), false);
});

test('Add Numbers in ThreeAddressCode', tacTest, {
    source: `
(function) main():
    r:a = 1; a = 1
    r:b = 2; b = 2
    r:sum = r:a + r:b; Add the things
    return r:sum; ret
`,
    exitCode: 3,
});

test('Stack Offset Load and Store', tacTest, {
    source: `
(function) (spill:2) main():
    r:temp = 1; Something to spill
    spill:1 r:temp; Spill it
    r:temp = 2; Use it for something else
    spill:2 r:temp; Spill this one too
    unspill:1 r:one; Load
    unspill:2 r:two; Load
    r:result = r:one + r:two; Add the things
    return r:result; ret
`,
    exitCode: 3,
    spills: 2,
});

test('Spill With Local Variables', mplTest, {
    source: `
a := 0;
t1 := a + 1;
t2 := a + 2;
t3 := a + 3;
t4 := a + 4;
t5 := a + 5;
t6 := a + 6;
t7 := a + 7;
t8 := a + 8;
t9 := a + 9;
t10 := a + 10;
t11 := a + 11;
t12 := a + 12;
t13 := a + 13;
t14 := a + 14;
t15 := a + 15;
t16 := a + 16;
t17 := a + 17;
t18 := a + 18;
t19 := a + 19;
return t19 - t16;
`,
    exitCode: 3,
});

// TODO: rewrite this in a way that it is guaranteed to cause spilling
test('Spill With Local Variables and Local Struct', mplTest, {
    source: `
IntPair := {
    first: Integer;
    second: Integer;
};

a := 0;
t1 := a + 1;
t2 := a + 2;
t3 := a + 3;
t4 := a + 4;
t5 := a + 5;
t6 := a + 6;
t7 := a + 7;
t8 := a + 8;
t9 := a + 9;
t10 := a + 10;
t11 := a + 11;
t12 := a + 12;
t13 := a + 13;
t14 := a + 14;
t15 := a + 15;
t16 := a + 16;
t17 := a + 17;
t18 := a + 18;
t19 := a + 19;
ip: IntPair = IntPair { first: t19, second: t8, };
return a + t1 + t2 + t3 + ip.first - ip.second;
`,
    exitCode: 17,
});

test.failing('Spill with Local Variables and Local Struct in Function', mplTest, {
    source: `
IntPair := {
    first: Integer;
    second: Integer;
};

foo := a: Integer => {
    t1 := a + 1;
    t2 := a + 2;
    t3 := a + 3;
    t4 := a + 4;
    t5 := a + 5;
    t6 := a + 6;
    t7 := a + 7;
    t8 := a + 8;
    t9 := a + 9;
    t10 := a + 10;
    t11 := a + 11;
    t12 := a + 12;
    t13 := a + 13;
    t14 := a + 14;
    t15 := a + 15;
    t16 := a + 16;
    t17 := a + 17;
    t18 := a + 18;
    t19 := a + 19;
    ip: IntPair = IntPair { first: t7, second: t18, };
    return ip.second - ip.first;
};

return foo(1);
`,
    exitCode: 11,
});

// TODO: rewrite this in a way that it is guaranteed to cause spilling
test.failing('2-level call tree with spilling', mplTest, {
    source: `

bar := a: Integer => {
    t1 := a + 1;
    t2 := a + 2;
    t3 := a + 3;
    t4 := a + 4;
    t5 := a + 5;
    t6 := a + 6;
    t7 := a + 7;
    t8 := a + 8;
    t9 := a + 9;
    t10 := a + 10;
    t11 := a + 11;
    t12 := a + 12;
    t13 := a + 13;
    t14 := a + 14;
    t15 := a + 15;
    t16 := a + 16;
    t17 := a + 17;
    t18 := a + 18;
    t19 := a + 19;
    return t19 - t18;
};

foo := a: Integer => {
    t1 := a + 1;
    t2 := a + 2;
    t3 := a + 3;
    t4 := a + 4;
    t5 := a + 5;
    t6 := a + 6;
    t7 := a + 7;
    t8 := a + 8;
    t9 := a + 9;
    t10 := a + 10;
    t11 := a + 11;
    t12 := a + 12;
    t13 := a + 13;
    t14 := a + 14;
    t15 := a + 15;
    t16 := a + 16;
    t17 := a + 17;
    t18 := a + 18;
    t19 := a + 19;
    return bar(t19 - t18);
};

return foo(1);
`,
    exitCode: 1,
});

test('Parse grammar from multiple entry points', t => {
    type TestToken = 'a' | 'b';
    type TestNode = 'a' | 'b';

    const tacTerminal = token => Terminal<TestNode, TestToken>(token);

    const testGrammar = {
        a: tacTerminal('a'),
        b: tacTerminal('b'),
    };

    const dummySourceLocation = { line: 0, column: 0 };

    // Try parsing from an a
    const aresult = parse(testGrammar, 'a', [{ type: 'a', string: 'anything', sourceLocation: dummySourceLocation }]);
    t.deepEqual(aresult, {
        newIndex: 1,
        sourceLocation: dummySourceLocation,
        success: true,
        type: 'a',
        value: undefined,
    });

    // Try parsing from a b
    const bresult = parse(testGrammar, 'b', [{ type: 'b', string: 'anything', sourceLocation: dummySourceLocation }]);
    t.deepEqual(bresult, {
        newIndex: 1,
        sourceLocation: dummySourceLocation,
        success: true,
        type: 'b',
        value: undefined,
    });

    // Try parsing from a when there are extra tokens
    const afail = parse(testGrammar, 'a', [
        { type: 'a', string: 'anything', sourceLocation: dummySourceLocation },
        { type: 'a', string: 'anything', sourceLocation: dummySourceLocation },
    ]);
    t.deepEqual(afail, {
        kind: 'parseError',
        errors: [
            {
                expected: 'endOfFile',
                found: 'a',
                foundTokenText: 'anything',
                sourceLocation: {
                    column: 0,
                    line: 0,
                },
                whileParsing: ['a'],
            },
        ],
    });
});

test('Parse instructions with no comment', t => {
    const result = parseInstructions(`
        r:d = r:l + r:r;
        r:r = r:l2 - r:d;
    `);
    t.deepEqual(result, [
        {
            destination: { name: 'd' },
            lhs: { name: 'l' },
            rhs: { name: 'r' },
            kind: 'add',
            why: '\n',
        },
        {
            destination: { name: 'r' },
            lhs: { name: 'l2' },
            rhs: { name: 'd' },
            kind: 'subtract',
            why: '\n',
        },
    ]);
});

test('Parse function call', t => {
    const noResult = parseInstructions(`
        r:fn(r:arg);
    `);
    t.deepEqual(noResult, [
        {
            kind: 'callByRegister',
            function: { name: 'fn' },
            arguments: [{ name: 'arg' }],
            destination: null,
            why: '\n',
        },
    ]);
    const result = parseInstructions(`
        r:result = r:fn(r:arg);
    `);
    t.deepEqual(result, [
        {
            kind: 'callByRegister',
            function: { name: 'fn' },
            arguments: [{ name: 'arg' }],
            destination: { name: 'result' },
            why: '\n',
        },
    ]);
});

// TODO: need to refactor parser lib for better parsing of optionals
test.failing('Parse "x" with "x?x"', t => {
    type TestNode = 'xNode';
    type TestToken = 'xToken';

    const opt = parser => Optional<TestNode, TestToken>(parser);
    const term = parser => Terminal<TestNode, TestToken>(parser);

    const testGrammar: Grammar<TestNode, TestToken> = {
        x: Sequence('x?x', [opt(term('xToken')), term('xToken')]),
    };

    const tokens: Token<TestToken>[] = [{ type: 'xToken', string: 'xToken', sourceLocation: { line: 0, column: 0 } }];
    const ast = parse(testGrammar, 'x', tokens);
    t.deepEqual(stripSourceLocation(stripResultIndexes(ast)), {
        children: [{ type: 'xToken', value: undefined }],
        type: 'x?x',
    });
});

test('Assign registers for syscall-only functions', t => {
    const f = threeAddressCodeRuntime.printWithPrintRuntimeFunction(0);
    const assigned = assignRegisters(f, [{ name: 'someRegister' }]);
    // Print function should new need any registers, should spill nothing,
    // and should not change the function.
    t.deepEqual(assigned, {
        assignment: {
            registerMap: { result: { name: 'someRegister' } },
            spilled: [],
        },
        newFunction: f,
    });
});

test('Range', t => {
    t.deepEqual(range(6, 9), [6, 7, 8]);
});

test('Unordered Set - Remove Only Element', t => {
    const s = set<number>((lhs, rhs) => lhs == rhs);
    s.add(1);
    s.removeWithPredicate(_ => true);
    t.deepEqual(s.toList(), []);
});

test('Ordered Set Insertion', t => {
    const s = orderedSet<number>(operatorCompare);
    s.add(1);
    s.add(2);
    s.add(3);
    t.deepEqual(s.toList(), [1, 2, 3]);

    s.add(2);
    s.add(3);
    s.add(5);
    s.add(4);
    t.deepEqual(s.toList(), [1, 2, 3, 4, 5]);
});

test('Ordered Set Insertion Fuzz', t => {
    const expected = range(0, 100);
    const doubleAdd = range(20, 50);
    for (let seed = 0; seed < 100; seed++) {
        const shuffled = shuffle(expected, seed);
        const s = orderedSet<number>(operatorCompare);

        shuffled.forEach(x => s.add(x));
        doubleAdd.forEach(x => s.add(x));

        const traversed = s.toList();
        t.deepEqual(expected, traversed);
    }
});

test('Ordered Set Removal', t => {
    const s = orderedSet<number>(operatorCompare);
    s.add(1);
    s.add(2);
    s.add(3);
    s.add(5);
    s.add(4);
    s.remove(3);
    t.deepEqual(s.toList(), [1, 2, 4, 5]);
});

test('Ordered Set Remove Only Element', t => {
    const s = orderedSet<number>(operatorCompare);
    s.add(1);
    s.remove(1);
    t.deepEqual(s.toList(), []);
});

test('Ordered Set Remove Lower Inner Element', t => {
    const s = orderedSet<number>(operatorCompare);

    const inserted = [1, 3, 2, 4];
    const removed = [3];

    inserted.forEach(x => s.add(x));
    removed.forEach(x => s.remove(x));
    t.deepEqual(s.toList(), [1, 2, 4]);
});

test('Ordered Set Remove Central Leaf', t => {
    const s = orderedSet<number>(operatorCompare);

    const inserted = [3, 1, 2, 0];
    const removed = [2];

    inserted.forEach(x => s.add(x));
    removed.forEach(x => s.remove(x));
    t.deepEqual(s.toList(), [0, 1, 3]);
});

test('Ordered Set Remove Higher Inner Element', t => {
    const s = orderedSet<number>(operatorCompare);

    const inserted = [3, 1, 2, 0];
    const removed = [1];

    inserted.forEach(x => s.add(x));
    removed.forEach(x => s.remove(x));
    t.deepEqual(s.toList(), [0, 2, 3]);
});

test('Ordered Set Remove With Deep Tree', t => {
    const s = orderedSet<number>(operatorCompare);

    const inserted = [1, 3, 2, 5, 4];
    const removed = [3];

    inserted.forEach(x => s.add(x));
    removed.forEach(x => s.remove(x));
    t.deepEqual(s.toList(), [1, 2, 4, 5]);
});

test('Ordered Set Remove - regression', t => {
    const s = orderedSet<number>(operatorCompare);

    const inserted = [88, 35, 52, 72, 63, 81, 45, 57];
    const removed = [52, 57];

    inserted.forEach(x => s.add(x));
    removed.forEach(x => s.remove(x));

    t.deepEqual(s.toList(), [35, 45, 63, 72, 81, 88]);
});

test('Ordered Set Remove - Least Upper Bound has Higher Elements', t => {
    const s = orderedSet<number>(operatorCompare);

    const inserted = [1, 0, 4, 2, 3];
    inserted.forEach(x => s.add(x));
    s.remove(1);
    t.deepEqual(s.toList(), [0, 2, 3, 4]);
});

test('Ordered Set To List After Removing', async t => {
    const s = orderedSet<number>(operatorCompare);

    const inserted = [88, 97, 93, 99, 34, 94];
    const removed = [99, 88, 97, 60, 91];

    inserted.forEach(x => s.add(x));
    removed.forEach(x => s.remove(x));
    t.deepEqual(s.toList(), [34, 93, 94]);
});

test('Ordered Set Remove Top of Left Leaning Tree', t => {
    const s = orderedSet<number>(operatorCompare);

    s.add(2);
    s.add(3);
    s.add(1);
    s.add(0);

    s.remove(2);
    t.deepEqual(s.toList(), [0, 1, 3]);
});

test('Ordered Set Remove Upside Down Nike Symbol', t => {
    const s = orderedSet<number>(operatorCompare);

    const inserted = [88, 90, 77, 70];
    const removed = [78, 88, 77];

    inserted.forEach(x => s.add(x));
    removed.forEach(x => s.remove(x));

    t.deepEqual(s.toList(), [70, 90]);
});

test('Ordered Set Remove Last Item Regression', t => {
    const s = orderedSet<number>(operatorCompare);

    const inserted = [3, 2, 0, 1, 4];
    const removed = [2, 3, 4];

    inserted.forEach(x => s.add(x));
    removed.forEach(x => s.remove(x));

    t.deepEqual(s.toList(), [0, 1]);
});

test('Ordered Set Remove All Regression', t => {
    const s = orderedSet<number>(operatorCompare);

    const inserted = [3, 2, 4];
    const removed = [2, 3, 4];

    inserted.forEach(x => s.add(x));
    removed.forEach(x => s.remove(x));

    t.deepEqual(s.toList(), []);
});

test('Ordered Set Remove Fuzz', t => {
    const inserted = range(0, 100);
    const removed = range(50, 100);
    const remaining = range(0, 50);
    for (let seed = 0; seed < 100; seed++) {
        const s = orderedSet<number>(operatorCompare);

        shuffle(inserted, seed).forEach(x => s.add(x));
        shuffle(removed, seed).forEach(x => s.remove(x));

        const traversed = s.toList();
        t.deepEqual(remaining, traversed);
        t.deepEqual(s.size(), 50);
    }
});

test('Oredered Set Remove With Predicate Fuzz', t => {
    const inserted = range(0, 100);
    const remaining = range(0, 51);
    for (let seed = 0; seed < 100; seed++) {
        const s = orderedSet<number>(operatorCompare);

        shuffle(inserted, seed).forEach(x => s.add(x));
        s.removeWithPredicate(item => item > 50);

        const traversed = s.toList();
        t.deepEqual(remaining, traversed);
        t.deepEqual(s.size(), 51);
    }
});

test('Ordered Set Size', t => {
    const s = orderedSet<number>(operatorCompare);

    t.deepEqual(s.size(), 0);
    s.add(1);
    t.deepEqual(s.size(), 1);
    s.add(0);
    t.deepEqual(s.size(), 2);
    s.add(2);
    t.deepEqual(s.size(), 3);
    s.remove(0);
    t.deepEqual(s.size(), 2);
});

test('Ordered Set Extract One', t => {
    const s = orderedSet<number>(operatorCompare);

    s.add(1);
    s.add(2);
    s.add(3);
    s.add(4);

    const extracted3 = s.extractOne(x => x == 3);
    t.deepEqual(extracted3, 3);
    t.deepEqual(s.toList(), [1, 2, 4]);
    const extracted1 = s.extractOne(x => x == 1);
    t.deepEqual(extracted1, 1);
    t.deepEqual(s.toList(), [2, 4]);
    const extractedNothing = s.extractOne(x => x == 5);
    t.deepEqual(extractedNothing, null);
});

// TODO: Turn this into a screenshot test somehow.
test('Ordered Set Dotfile', async t => {
    const s = orderedSet<number>(operatorCompare);

    const inserted = [88, 35, 52, 72, 63, 81, 45, 57];
    const removed = [52, 57];

    inserted.forEach(x => s.add(x));
    removed.forEach(x => s.remove(x));

    const dotText = s.toDotFile();
    t.deepEqual(
        dotText,
        `digraph {
node_0 [shape="box", label="35" pos="0,1!"]
node_1 [shape="box", label="45" pos="1,3!"]
node_2 [shape="box", label="63" pos="2,2!"]
node_3 [shape="box", label="72" pos="3,3!"]
node_4 [shape="box", label="81" pos="4,4!"]
node_5 [shape="box", label="88" pos="5,0!"]
node_0 -> node_5 [constraint=false label="p"]
null_0 [shape="point"]
node_0 -> null_0
node_0 -> node_2
null_0 -> node_2 [style="invis"]
{rank=same; null_0; node_2;}
node_1 -> node_2 [constraint=false label="p"]
null_1 [shape="point"]
node_1 -> null_1
null_2 [shape="point"]
node_1 -> null_2
null_1 -> null_2 [style="invis"]
{rank=same; null_1; null_2;}
node_2 -> node_0 [constraint=false label="p"]
node_2 -> node_1
node_2 -> node_3
node_1 -> node_3 [style="invis"]
{rank=same; node_1; node_3;}
node_3 -> node_2 [constraint=false label="p"]
null_3 [shape="point"]
node_3 -> null_3
node_3 -> node_4
null_3 -> node_4 [style="invis"]
{rank=same; null_3; node_4;}
node_4 -> node_3 [constraint=false label="p"]
null_4 [shape="point"]
node_4 -> null_4
null_5 [shape="point"]
node_4 -> null_5
null_4 -> null_5 [style="invis"]
{rank=same; null_4; null_5;}
null_6 [shape="point"]
node_5 -> null_6 [constraint=false label="p"]
node_5 -> node_0
null_7 [shape="point"]
node_5 -> null_7
node_0 -> null_7 [style="invis"]
{rank=same; node_0; null_7;}
{rank=same;node_0;}
{rank=same;node_1;node_3;}
{rank=same;node_2;}
{rank=same;node_4;}
{rank=same;node_5;}
}`
    );

    // await writeSvg(dotText, './set.svg');
});
