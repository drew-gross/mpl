import { file as tmpFile } from 'tmp-promise';
import { writeFile } from 'fs-extra';
import testCases from './test-cases.js';
import { parseFunction, parseProgram as parseTacProgram, parseInstructions } from './threeAddressCode/parser.js';
import prettyParseError from './parser-lib/pretty-parse-error.js';
import { equal as typesAreEqual, builtinTypes, Type, TypeDeclaration } from './types.js';
import { ThreeAddressFunction } from './threeAddressCode/generator.js';
import { Statement } from './threeAddressCode/statement.js';
import * as threeAddressCodeRuntime from './threeAddressCode/runtime.js';
import test from 'ava';
import flatten from './util/list/flatten.js';
import join from './util/join.js';
import { lex, Token } from './parser-lib/lex.js';
import { parseMpl, compile, typeCheckStatement, astFromParseResult, typeOfExpression } from './frontend.js';
import { mplTest, tacTest } from './test-utils.js';
import { grammar, tokenSpecs, MplParseResult, MplAst, MplToken } from './grammar.js';
import {
    stripResultIndexes,
    parse,
    parseResultIsError,
    stripSourceLocation,
    Grammar,
    Sequence,
    OneOf,
    Terminal,
    Optional,
} from './parser-lib/parse.js';
import * as Ast from './ast.js';
import { removeBracketsFromAst } from './frontend.js';
import { controlFlowGraph, toDotFile, BasicBlock, computeBlockLiveness, tafLiveness } from './controlFlowGraph.js';
import debug from './util/debug.js';
import { backends } from './backend-utils.js';

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

test('double product with brackets', mplTest, {
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
        ],
    },
});

testCases.forEach(({ name, source, exitCode, failing }) => {
    if (failing) {
        test.failing(name, mplTest, { source, exitCode, name });
    } else {
        test(name, mplTest, { source, exitCode, name });
    }
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

test('id function', mplTest, {
    source: 'id := a: Integer => a; return id(5)',
    exitCode: 5,
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

test('factorial', mplTest, {
    source: `
factorial := x: Integer => x == 1 ? 1 : x * factorial(x - 1);
return factorial(5);`,
    exitCode: 120,
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

test('return local integer', mplTest, {
    source: 'myVar: Integer = 3 * 3; return myVar',
    exitCode: 9,
});

test('many temporaries, spill to ram', mplTest, {
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

test('string length', mplTest, {
    source: `myStr: String = "test"; return length(myStr);`,
    exitCode: 4,
});

test('empty string length', mplTest, {
    source: `myStr: String = ""; return length(myStr);`,
    exitCode: 0,
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

test('string copy', mplTest, {
    source: `myStr1: String = "testing"; myStr2: String = myStr1; return length(myStr2);`,
    exitCode: 7,
});

test('string equality: equal', mplTest, {
    source: `str1 := "a";
str2 := "a";
return str1 == str2 ? 1 : 2;
`,
    exitCode: 1,
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

// TODO: Needs register allocator with proper spilling
test.failing('complex string concatenation', mplTest, {
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

test('parsing fails for extra invalid tokens', mplTest, {
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

test('zero args', mplTest, {
    source: `
const11 := () => 11;
return const11();`,
    exitCode: 11,
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

test('print', mplTest, {
    source: `
dummy := print("sample_string");
return 1;`,
    exitCode: 1,
    expectedStdOut: 'sample_string',
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

test('reassign string', mplTest, {
    source: `
a := "Hello";
dummy := print(a);
a = "World!!!!!";
dummy = print(a);
return dummy - dummy;`,
    exitCode: 0,
    expectedStdOut: 'HelloWorld!!!!!',
});

test('reassign to a using expression including a', mplTest, {
    source: `
hello := "HelloWorld";
hello = hello ++ "!";
return length(hello);`,
    exitCode: 11,
});

test.failing('good parse error for missing semi-colon', mplTest, {
    source: `
foo = () => {
    return 1;
}
return foo();`,
    expectedParseErrors: ['you forgot a semi-colon'],
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

test('reassign string inside function', mplTest, {
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

test('int pair', mplTest, {
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

test('int pair in function', mplTest, {
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

test('multiple int pairs in function', mplTest, {
    source: `
IntPair := {
    first: Integer;
    second: Integer;
};

ip1: IntPair = IntPair { first: 1, second: 2, };
ip2: IntPair = IntPair { first: 3, second: 4, };
return ip1.first + ip1.second + ip2.second;
`,
    exitCode: 7,
});

test('controlFlowGraph basic test', t => {
    const rtl: Statement[] = [
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
        instructions: parseInstructions(`
            r:d = r:l + r:r # d = l + r
            r:r = r:l2 - r:d # r = l2 - d
            r:v = r:l # v = l (dead)
            r:v = r:r # v = r
        `) as Statement[],
    };
    const liveness = computeBlockLiveness(block).map(l => l.toList().sort());
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
        spills: 0,
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
        spills: 0,
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
        spills: 0,
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

    const result = parseTacProgram(source);
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

test('Add Numbers in ThreeAddressCode', tacTest, {
    source: `
(function) main:
r:a = 1 # a = 1
r:b = 2 # b = 2
r:sum = r:a + r:b # Add the things
r:functionResult = r:sum # Result = sum
`,
    exitCode: 3,
});

test('Stack Offset Load and Store', tacTest, {
    source: `
(function) (spill:2) main:
r:temp = 1 # Something to spill
spill:1 r:temp # Spill it
r:temp = 2 # Use it for something else
spill:2 r:temp # Spill this one too
unspill:1 r:one # Load
unspill:2 r:two # Load
r:functionResult = r:one + r:two # Add the things
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

test.failing('Spill With Local Variables and Local Struct', mplTest, {
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

test('Spill with Local Variables and Local Struct in Function', mplTest, {
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

// This will fail due to needing to make adjust stack pointer to make room for spilled temporaries.
// Currently each functions in the stack's spills will clobber it's parents.
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

test.failing('Spill self-assigning multiply', mplTest, {
    source: `
// TODO: enough stuff to cause a spill. then a = a * a. Or make this
// a direct test of spill().
`,
});

test('Parse grammar from multiple entry points', t => {
    type TestToken = 'a' | 'b';
    type TestNode = 'a' | 'b';

    const tacTerminal = token => Terminal<TestNode, TestToken>(token);
    const tacOptional = parser => Optional<TestNode, TestToken>(parser);

    const grammar = {
        a: tacTerminal('a'),
        b: tacTerminal('b'),
    };

    const dummySourceLocation = { line: 0, column: 0 };

    // Try parsing from an a
    const aresult = parse(grammar, 'a', [{ type: 'a', string: 'anything', sourceLocation: dummySourceLocation }]);
    t.deepEqual(aresult, {
        newIndex: 1,
        sourceLocation: dummySourceLocation,
        success: true,
        type: 'a',
        value: undefined,
    });

    // Try parsing from a b
    const bresult = parse(grammar, 'b', [{ type: 'b', string: 'anything', sourceLocation: dummySourceLocation }]);
    t.deepEqual(bresult, {
        newIndex: 1,
        sourceLocation: dummySourceLocation,
        success: true,
        type: 'b',
        value: undefined,
    });

    // Try parsing from a when there are extra tokens
    const afail = parse(grammar, 'a', [
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
