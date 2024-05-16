import uniqueCmp from './util/list/uniqueCmp';
import uniqueBy from './util/list/uniqueBy';
import { testPrograms, testModules } from './test-cases';
import { TestModule, TestProgram, Test, mplTest, tacTest, moduleTest } from './test-case';
import { parseInstructions } from './threeAddressCode/parser';
import { parseProgram as parseTacProgram } from './threeAddressCode/Program';
import annotateSource from './annotateSource';
import { equal as typesAreEqual, builtinTypes, Type } from './types';
import {
    Function,
    toString as functionToString,
    parseFunctionOrDie,
} from './threeAddressCode/Function';
import { Register } from './threeAddressCode/Register';
import { Statement } from './threeAddressCode/statement';
import * as threeAddressCodeRuntime from './threeAddressCode/runtime';
import test from 'ava';
import flatten from './util/list/flatten';
import join from './util/join';
import range from './util/list/range';
import { lex, Token } from './parser-lib/lex';
import { parseMpl, compile, astFromParseResult, typeOfExpression } from './frontend';
import { grammar, tokenSpecs, MplParseResult, MplAst, MplToken } from './grammar';
import {
    parse,
    parseResultIsError,
    stripSourceLocation,
    Terminal,
    Optional,
    Grammar,
    Sequence,
    OneOf,
    SeparatedList,
    Many,
} from './parser-lib/parse';
import * as Ast from './ast';
import { removeBracketsFromAst } from './frontend';
import {
    assignRegisters,
    controlFlowGraph,
    BasicBlock,
    computeBlockLiveness,
    tafLiveness,
    removeDeadStores,
} from './controlFlowGraph';
import { orderedSet, operatorCompare } from './util/ordered-set';
import { set } from './util/set';
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
        {
            type: 'leftBracket',
            value: null,
            string: '(',
            sourceLocation: { line: 1, column: 1 },
        },
        { type: 'number', value: 1, string: '1', sourceLocation: { line: 1, column: 2 } },
        {
            type: 'rightBracket',
            value: null,
            string: ')',
            sourceLocation: { line: 1, column: 3 },
        },
    ]);
    t.deepEqual(lex(tokenSpecs, 'return 100'), [
        {
            type: 'return',
            value: null,
            string: 'return',
            sourceLocation: { line: 1, column: 1 },
        },
        { type: 'number', value: 100, string: '100', sourceLocation: { line: 1, column: 8 } },
    ]);
    t.deepEqual(lex(tokenSpecs, 'return "test string"'), [
        {
            type: 'return',
            value: null,
            string: 'return',
            sourceLocation: { line: 1, column: 1 },
        },
        {
            type: 'stringLiteral',
            value: 'test string',
            string: 'test string',
            sourceLocation: { line: 1, column: 8 },
        },
    ]);
});

test('lex with initial whitespace', t => {
    t.deepEqual(lex(tokenSpecs, ' 123'), [
        { type: 'number', value: 123, string: '123', sourceLocation: { line: 1, column: 2 } },
    ]);
});

test('lex type identifier', t => {
    t.deepEqual(lex(tokenSpecs, 'Boolean[]'), [
        {
            string: 'Boolean',
            type: 'typeIdentifier',
            value: 'Boolean',
            sourceLocation: { line: 1, column: 1 },
        },
        {
            string: '[',
            type: 'leftSquareBracket',
            value: null,
            sourceLocation: { column: 8, line: 1 },
        },
        {
            string: ']',
            type: 'rightSquareBracket',
            value: null,
            sourceLocation: { column: 9, line: 1 },
        },
    ] as any);
});

test('ast for single number', t => {
    const tokens = lex(tokenSpecs, 'return 7;') as Token<MplToken>[];
    const parseResult = parse(grammar, 'program', tokens);
    if (parseResultIsError(parseResult)) {
        console.log(parseResult);
        t.fail('Parse Failed');
        return;
    }
    const expectedResult = {
        type: 'program',
        children: [
            {
                type: 'statement',
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
                                value: 7,
                                sourceLocation: { line: 1, column: 8 },
                            },
                        ],
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
            parse(grammar, 'program', lex(tokenSpecs, ' return (5);') as Token<MplToken>[])
        ),
        {
            type: 'program',
            sourceLocation: { line: 1, column: 2 },
            children: [
                {
                    type: 'statement',
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
                            ],
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
            parse(grammar, 'program', lex(tokenSpecs, 'return ((20));') as Token<MplToken>[])
        ),
        {
            type: 'program',
            sourceLocation: { line: 1, column: 1 },
            children: [
                {
                    type: 'statement',
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
                            ],
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
            parse(
                grammar,
                'program',
                lex(tokenSpecs, 'return 3 * (4 * 5);') as Token<MplToken>[]
            )
        ),
        {
            type: 'program',
            sourceLocation: { line: 1, column: 1 },
            children: [
                {
                    type: 'statement',
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
                        type: 'declaration',
                        children: [
                            { type: 'identifier', value: 'constThree' },
                            { type: 'colon', value: null },
                            { type: 'assignment', value: null },
                            {
                                type: 'function',
                                children: [
                                    // TODO pretty sure the commented out version is actaully correct
                                    {
                                        // type: 'arg',
                                        // children: [
                                        //     {
                                        //         type: 'identifier',
                                        //         value: 'a',
                                        //     },
                                        //     {
                                        //         type: 'colon',
                                        //         value: null,
                                        //     },
                                        //     {
                                        //         type: 'typeWithoutArgs',
                                        //         children: [
                                        //             {
                                        //                 type: 'typeIdentifier',
                                        //                 value: 'Integer',
                                        //             },
                                        //         ],
                                        //     },
                                        // ],
                                        type: undefined,
                                        value: undefined,
                                    },
                                    { type: 'fatArrow', value: null },
                                    { type: 'number', value: 3 },
                                ],
                            },
                        ],
                    },
                    { type: 'statementSeparator', value: null },
                    {
                        type: 'statement',
                        children: [
                            {
                                type: 'returnStatement',
                                children: [
                                    { type: 'return', value: null },
                                    { type: 'number', value: 10 },
                                ],
                            },
                            { type: 'statementSeparator', value: null },
                        ],
                    },
                ],
            },
        ],
    };
    const astWithSemicolon = stripSourceLocation(
        removeBracketsFromAst(
            parse(
                grammar,
                'program',
                lex(tokenSpecs, 'constThree := a: Integer => 3; return 10;') as Token<MplToken>[]
            )
        )
    );
    t.deepEqual(astWithSemicolon, expected);
});

test('parse for', t => {
    const source = `
        for (a : b) {
            a = b;
        };
    `;
    const ast = parse(grammar, 'program', lex(tokenSpecs, source) as Token<MplToken>[]);
    t.deepEqual(stripSourceLocation(ast), {
        type: 'program',
        children: [
            {
                type: 'statement' as any,
                children: [
                    {
                        type: 'forLoop' as any,
                        children: [
                            { value: null, type: 'for' as any },
                            {
                                type: 'forCondition' as any,
                                children: [
                                    { value: 'a', type: 'identifier' as any },
                                    { value: null, type: 'colon' as any },
                                    { value: 'b', type: 'identifier' as any },
                                ],
                            },
                            {
                                type: 'statement' as any,
                                children: [
                                    {
                                        type: 'reassignment' as any,
                                        children: [
                                            { value: 'a', type: 'identifier' as any },
                                            { value: null, type: 'assignment' as any },
                                            { value: 'b', type: 'identifier' as any },
                                        ],
                                    },
                                    { value: null, type: 'statementSeparator' as any },
                                ],
                            },
                        ],
                    },
                    { value: null, type: 'statementSeparator' as any },
                ],
            },
        ],
    });
});

test('lowering of bracketedExpressions', t => {
    const lexResult = lex(tokenSpecs, 'return (8 * ((7)));') as Token<MplToken>[];
    t.deepEqual(stripSourceLocation(parseMpl(lexResult)), {
        type: 'program',
        children: [
            {
                type: 'statement',
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
                        type: 'statementSeparator',
                        value: null,
                    },
                ],
            },
        ],
    });
});

test('correct inferred type for function', t => {
    const functionSource = 'a: Integer => 11';
    const parseResult: MplParseResult = parse(
        grammar,
        'function',
        lex(tokenSpecs, functionSource) as Token<MplToken>[]
    );
    const ast: Ast.UninferredExpression = astFromParseResult(
        parseResult as MplAst
    ) as Ast.UninferredExpression;
    t.deepEqual(typeOfExpression({ w: ast, availableVariables: [], availableTypes: [] }), {
        type: {
            type: {
                kind: 'Function',
                arguments: [{ type: { kind: 'Integer' } }],
                permissions: [],
                returnType: { type: { kind: 'Integer' } },
            },
        },
        extractedFunctions: [
            {
                name: 'anonymous_1',
                parameters: [
                    { name: 'a', type: { type: { kind: 'Integer' } }, exported: false },
                ],
                returnType: { type: { kind: 'Integer' as 'Integer' } },
                statements: [
                    {
                        expression: {
                            kind: 'number' as 'number',
                            sourceLocation: { column: 15, line: 1 },
                            value: 11,
                        },
                        kind: 'returnStatement' as 'returnStatement',
                        sourceLocation: { column: 1, line: 1 },
                    },
                ],
                variables: [
                    {
                        name: 'a',
                        type: { type: { kind: 'Integer' as 'Integer' } },
                        exported: false,
                    },
                ],
            },
        ],
    });
});

const getRunner = ({ name, infiniteLooping, failing, only }: Test) => {
    if (infiniteLooping) {
        return () => {
            test.failing(name, t => {
                t.fail();
            });
        };
    }
    return only ? test.only : failing ? test.failing : test;
};

testPrograms.forEach((testProgram: TestProgram) => {
    getRunner(testProgram)(testProgram.name, mplTest, testProgram);
});

testModules.forEach((testModule: TestModule) => {
    getRunner(testModule)(testModule.name, moduleTest, testModule);
});

test('assign function with no args to typed var', mplTest, {
    source: `
myFunc: Function<Integer> = () => 111;
return myFunc();`,
    exitCode: 111,
});

test('return local integer', mplTest, {
    source: 'myVar: Integer = 3 * 3; return myVar;',
    exitCode: 9,
});

test.failing('many temporaries, spill to ram', mplTest, {
    source:
        'return 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1',
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
    typeErrors: [
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

test.failing('string length with type inferred', mplTest, {
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

test.failing('string equality: inequal same length', mplTest, {
    source: `str1 := "a";
str2 := "b";
return str1 == str2 ? 1 : 2;
`,
    exitCode: 2,
    failing: true,
});

test.failing('string equality: inequal different length', mplTest, {
    source: `str1 := "aa";
str2 := "a";
return str1 == str2 ? 7 : 2;
`,
    exitCode: 2,
});

test('wrong type global', mplTest, {
    source: `str: String = 5; return length(str);`,
    typeErrors: [
        {
            kind: 'assignWrongType',
            lhsName: 'str',
            lhsType: builtinTypes.String,
            rhsType: builtinTypes.Integer,
            sourceLocation: { line: 1, column: 1 },
        },
    ],
});

test.failing('concatenate and get length then subtract', mplTest, {
    source: `return length("abc" ++ "defg") - 2;`,
    exitCode: 5,
});

test('parsing fails for extra invalid tokens', mplTest, {
    source: `return 5; (`,
    parseErrors: [
        {
            found: 'leftBracket',
            expected: 'endOfFile',
            sourceLocation: { line: 1, column: 11 },
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

test('call with wrong number of args', mplTest, {
    source: `
threeArgs := a: Integer, b: Integer, c: Integer => a + b + c;
return threeArgs(7, 4);`,
    typeErrors: [
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
    typeErrors: [
        {
            kind: 'wrongArgumentType',
            targetFunction: 'threeArgs',
            expectedType: builtinTypes.Integer,
            passedType: builtinTypes.String,
            sourceLocation: { line: 3, column: 8 },
        },
    ],
});

test.failing('print string with space', mplTest, {
    source: `
dummy := print("sample string with space");
return 1;`,
    exitCode: 1,
    stdout: 'sample string with space',
    failing: true,
});

test.failing('require/force no return value for print', mplTest, {
    source: `
print("sample string");
return 1;`,
    exitCode: 1,
    stdout: 'sample string',
});

test.failing('print string containing number', mplTest, {
    source: `
dummy := print("1");
return 1 + dummy - dummy;`,
    exitCode: 1,
    stdout: '1',
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

test.failing('string args', mplTest, {
    source: `
excitmentifier := (boring: String) => {
    dummy := print(boring ++ "!");
    return 11 + dummy - dummy;
};
return excitmentifier("Hello World");`,
    stdout: 'Hello World!',
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
    typeErrors: [
        {
            kind: 'assignUndeclaredIdentifer',
            destinationName: 'b',
            sourceLocation: { line: 3, column: 1 },
        },
    ],
});

test('reassigning wrong type', mplTest, {
    source: `
a := 1;
a = true;
return a;`,
    typeErrors: [
        {
            kind: 'assignWrongType',
            lhsName: 'a',
            lhsType: builtinTypes.Integer,
            rhsType: builtinTypes.Boolean,
            sourceLocation: { line: 3, column: 1 },
        },
    ],
});

test.failing('reassign to a using expression including a', mplTest, {
    source: `
hello := "HelloWorld";
hello = hello ++ "!";
return length(hello);`,
    exitCode: 11,
});

test('reassigning wrong type inside function', mplTest, {
    source: `
foo := () => {
    a := 1;
    a = true;
    return a;
};
return foo();`,
    typeErrors: [
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

test('controlFlowGraph basic test', t => {
    const rtl: Statement[] = [
        {
            kind: 'functionLabel',
            name: 'test',
            why: 'test',
        },
        {
            kind: 'return',
            register: new Register('result'),
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
    const liveness = computeBlockLiveness(block, []).map(l =>
        l
            .toList()
            .map(x => x.name)
            .sort()
    );
    const expected = [['l', 'l2', 'r'], ['l', 'l2', 'd'], ['r', 'l'], ['r'], []].map(e =>
        e.sort()
    );
    t.deepEqual(liveness, expected);
});

test('computeBlockLiveness read and write in one', t => {
    const block: BasicBlock = {
        name: 'test',
        instructions: [
            {
                kind: 'subtract',
                lhs: new Register('r'),
                rhs: new Register('d'),
                destination: new Register('r'),
                why: 'r = r - d',
            },
            {
                kind: 'move',
                from: new Register('r'),
                to: new Register('v'),
                why: 'v = r',
            },
        ],
    };
    const liveness = computeBlockLiveness(block, []);
    const expected = [['r', 'd'], ['r'], []];
    t.deepEqual(liveness.length, expected.length);
    expected.forEach((e, i) => {
        t.deepEqual(
            e.sort(),
            liveness[i]
                .toList()
                .map(x => x.name)
                .sort()
        );
    });
});

test('liveness analysis basic test', t => {
    const testFunction: Function = {
        name: 'test',
        liveAtExit: [],
        arguments: [new Register('some_arg')],
        instructions: [
            {
                kind: 'add',
                lhs: new Register('add_l'),
                rhs: new Register('add_r'),
                destination: new Register('add_d'),
                why: 'add_d = add_l + add_r',
            },
            {
                kind: 'gotoIfZero',
                register: new Register('add_d'),
                label: 'L',
                why: 'if add_d == 0 goto L',
            },
            {
                kind: 'subtract',
                lhs: new Register('sub_l'),
                rhs: new Register('sub_r'),
                destination: new Register('sub_d'),
                why: 'sub_d = sub_l = sub_r',
            },
            { kind: 'label', name: 'L', why: 'L' },
        ],
    };
    const testFunctionLiveness = tafLiveness(testFunction).map(s => s.toList());
    const expectedLiveness = [
        [
            new Register('add_l'),
            new Register('add_r'),
            new Register('sub_l'),
            new Register('sub_r'),
            new Register('some_arg'),
        ],
        [
            new Register('add_d'),
            new Register('sub_l'),
            new Register('sub_r'),
            new Register('some_arg'),
        ],
        [new Register('sub_l'), new Register('sub_r'), new Register('some_arg')],
        [new Register('some_arg')],
        [],
    ];
    t.deepEqual(testFunctionLiveness, expectedLiveness);
});

test('4 block graph (length)', t => {
    const lengthRTLF: Function = {
        name: 'length',
        liveAtExit: [],
        arguments: [new Register('strPtr')],
        instructions: [
            {
                kind: 'loadImmediate',
                destination: new Register('result'),
                value: 0,
                why: 'result = 0',
            },
            { kind: 'label', name: 'length_loop', why: 'Count another charachter' },
            {
                kind: 'loadMemoryByte',
                address: new Register('strPtr'),
                to: new Register('currentChar'),
                why: 'currentChar = *ptr',
            },
            {
                kind: 'gotoIfZero',
                register: new Register('currentChar'),
                label: 'length_return',
                why: 'if currentChar == 0 goto length_return',
            },
            { kind: 'increment', register: new Register('result'), why: 'result++' },
            { kind: 'increment', register: new Register('strPtr'), why: 'arg1++' },
            { kind: 'goto', label: 'length_loop', why: 'goto length_loop' },
            { kind: 'label', name: 'length_return', why: 'length_return:' },
            {
                kind: 'subtract',
                lhs: new Register('strPtr'),
                rhs: new Register('result'),
                destination: new Register('strPtr'),
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
    const complexFunction: Function = {
        name: 'complexFunction',
        liveAtExit: [],
        arguments: [],
        instructions: [
            {
                kind: 'loadImmediate',
                destination: new Register('result'),
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
                destination: new Register('result'),
                value: 1,
                why: '',
            },
            {
                kind: 'gotoIfNotEqual',
                lhs: new Register('leftByte'),
                rhs: new Register('rightByte'),
                label: 'return_false',
                why: '',
            },
            {
                kind: 'gotoIfZero',
                register: new Register('leftByte'),
                label: 'return',
                why: '',
            },
            {
                kind: 'loadImmediate',
                destination: new Register('result'),
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
                destination: new Register('result'),
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
                type: {
                    kind: 'Function',
                    arguments: [],
                    permissions: [],
                    returnType: { type: { kind: 'Integer' } },
                },
            },
            {
                type: {
                    kind: 'Function',
                    arguments: [{ type: { kind: 'Integer' } }, { type: { kind: 'Integer' } }],
                    permissions: [],
                    returnType: { type: { kind: 'Integer' } },
                },
            }
        )
    );
});

test('equal types are equal', t => {
    t.assert(typesAreEqual({ type: { kind: 'Integer' } }, { type: { kind: 'Integer' } }));
});

test('list type equality', t => {
    t.assert(
        !typesAreEqual(
            { type: { kind: 'List', of: { type: { kind: 'Boolean' } } } },
            { type: { kind: 'List', of: { type: { kind: 'Integer' } } } }
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
                expression: {
                    kind: 'booleanLiteral',
                    value: true,
                    sourceLocation: { line: 6, column: 34 },
                },
            },
            {
                name: 'second',
                expression: {
                    kind: 'booleanLiteral',
                    value: false,
                    sourceLocation: { line: 6, column: 48 },
                },
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
                    type: {
                        kind: 'Product',
                        members: [
                            { name: 'first', type: { type: { kind: 'Boolean' } } },
                            { name: 'second', type: { type: { kind: 'Boolean' } } },
                        ],
                    },
                },
            },
        ],
    });
    const expectedType = {
        type: {
            type: {
                kind: 'Product' as 'Product',
                members: [
                    { name: 'first', type: { type: { kind: 'Boolean' } } },
                    { name: 'second', type: { type: { kind: 'Boolean' } } },
                ] as any,
            },
            original: { namedType: 'BoolPair' },
        },
        extractedFunctions: [],
    };
    t.deepEqual(type, expectedType);
});

// TODO: rethink how product types work
test.failing('no structural typing', t => {
    const leftType: Type = {
        type: {
            kind: 'Product',
            members: [
                { name: 'first', type: { type: { kind: 'Boolean' } } },
                { name: 'second', type: { type: { kind: 'Boolean' } } },
            ],
        },
    };
    const rightType: Type = {
        type: {
            kind: 'Product',
            members: [
                { name: 'first', type: { type: { kind: 'Boolean' } } },
                { name: 'second', type: { type: { kind: 'Boolean' } } },
            ],
        },
    };
    t.assert(!typesAreEqual(leftType, rightType));
});

test('pretty-parse-error', t => {
    // nominal test
    t.deepEqual(
        annotateSource(
            'contextBefore\n123456789\ncontextAfter',
            { line: 2, column: 4 },
            'message'
        ),
        'contextBefore\n123456789\n   ^ message\ncontextAfter'
    );

    // line out of range too low
    t.deepEqual(
        annotateSource('contextBefore\n123456789\ncontextAfter', { line: 0, column: 4 }, ''),
        null
    );
    // line out of range too high
    t.deepEqual(
        annotateSource('contextBefore\n123456789\ncontextAfter', { line: 4, column: 4 }, ''),
        null
    );
    // column out of range too low
    t.deepEqual(
        annotateSource('contextBefore\n123456789\ncontextAfter', { line: 2, column: 0 }, ''),
        null
    );

    // annotation is past line length
    t.deepEqual(
        annotateSource('contextBefore\n123456789\ncontextAfter', { line: 2, column: 10 }, ''),
        'contextBefore\n123456789\n         ^ \ncontextAfter'
    );

    // First line
    t.deepEqual(
        annotateSource('123456789\ncontextAfter', { line: 1, column: 1 }, 'm'),
        '123456789\n^ m\ncontextAfter'
    );
    // Last line
    t.deepEqual(
        annotateSource('contextBefore\n123456789', { line: 2, column: 9 }, 'm2'),
        'contextBefore\n123456789\n        ^ m2'
    );
    // Only line
    t.deepEqual(annotateSource('123456789', { line: 1, column: 1 }, 'm3'), '123456789\n^ m3');
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
                            annotateSource(
                                source,
                                e.sourceLocation,
                                `found ${e.found}, expected ${e.expected}`
                            ) || ''
                        );
                    }
                }),
                '\n\n'
            )
        );
    }
    t.deepEqual(Array.isArray(result), false);
});

test.failing('Add Numbers in ThreeAddressCode', tacTest, {
    source: `
(function) main():
    r:a = 1; a = 1
    r:b = 2; b = 2
    r:sum = r:a + r:b; Add the things
    return r:sum; ret
`,
    exitCode: 3,
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
    const aresult = parse(testGrammar, 'a', [
        { type: 'a', string: 'anything', sourceLocation: dummySourceLocation },
    ]);
    t.deepEqual(aresult, {
        sourceLocation: dummySourceLocation,
        type: 'a',
        value: undefined,
    });

    // Try parsing from a b
    const bresult = parse(testGrammar, 'b', [
        { type: 'b', string: 'anything', sourceLocation: dummySourceLocation },
    ]);
    t.deepEqual(bresult, {
        sourceLocation: dummySourceLocation,
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

test('Parser lib - SeparatedList', t => {
    type TestToken = 'a' | 'b' | 'comma';
    type TestNode = 'a' | 'b' | 'comma';
    const terminal = token => Terminal<TestNode, TestToken>(token);
    const a = terminal('a');
    const b = terminal('b');
    const comma = terminal('comma');
    const testGrammar = {
        a,
        b,
        comma,
        list: SeparatedList(comma, 'listItem'),
        listItem: OneOf([a, b]),
    };

    const dummySourceLocation = { line: 0, column: 0 };

    const zeroItemList: any = parse(testGrammar, 'list', []);
    t.deepEqual(zeroItemList, { items: [], separators: [] });

    const oneItemList: any = parse(testGrammar, 'list', [
        { type: 'a', string: 'anything', sourceLocation: dummySourceLocation },
    ]);
    t.deepEqual(oneItemList, {
        items: [{ sourceLocation: dummySourceLocation, type: 'a', value: undefined }],
        separators: [],
    });

    const twoItemList: any = parse(testGrammar, 'list', [
        { type: 'a', string: 'a', sourceLocation: dummySourceLocation },
        { type: 'comma', string: ',', sourceLocation: dummySourceLocation },
        { type: 'b', string: 'b', sourceLocation: dummySourceLocation },
    ]);
    t.deepEqual(twoItemList, {
        items: [
            { type: 'a', value: undefined, sourceLocation: dummySourceLocation },
            { type: 'b', value: undefined, sourceLocation: dummySourceLocation },
        ],
        separators: [{ type: 'comma', value: undefined, sourceLocation: dummySourceLocation }],
    });

    const threeItemList: any = parse(testGrammar, 'list', [
        { type: 'a', string: 'a', sourceLocation: dummySourceLocation },
        { type: 'comma', string: ',', sourceLocation: dummySourceLocation },
        { type: 'b', string: 'b', sourceLocation: dummySourceLocation },
        { type: 'comma', string: ',', sourceLocation: dummySourceLocation },
        { type: 'a', string: 'a', sourceLocation: dummySourceLocation },
    ]);
    t.deepEqual(threeItemList, {
        items: [
            { sourceLocation: dummySourceLocation, type: 'a', value: undefined },
            { sourceLocation: dummySourceLocation, type: 'b', value: undefined },
            { sourceLocation: dummySourceLocation, type: 'a', value: undefined },
        ],
        separators: [
            { sourceLocation: dummySourceLocation, type: 'comma', value: undefined },
            { sourceLocation: dummySourceLocation, type: 'comma', value: undefined },
        ],
    });
});

test('Parser Lib - Many', t => {
    type TestToken = 'a' | 'b';
    type TestNode = 'a' | 'b';
    const terminal = token => Terminal<TestNode, TestToken>(token);
    const a = terminal('a');
    const b = terminal('b');
    const testGrammar = { a, b, asAndBs: Sequence('asAndBs', [Many(a), Many(b)]) };

    const dummySourceLocation = { line: 0, column: 0 };

    const zeroItemList: any = parse(testGrammar, 'asAndBs', []);
    t.deepEqual(zeroItemList, {
        children: [{ items: [] }, { items: [] }],
        sourceLocation: dummySourceLocation,
        type: 'asAndBs',
    });

    const twoAs: any = parse(testGrammar, 'asAndBs', [
        { type: 'a', string: 'a', sourceLocation: dummySourceLocation },
        { type: 'a', string: 'a', sourceLocation: dummySourceLocation },
    ]);
    t.deepEqual(twoAs, {
        children: [
            {
                items: [
                    { sourceLocation: dummySourceLocation, type: 'a', value: undefined },
                    { sourceLocation: dummySourceLocation, type: 'a', value: undefined },
                ],
            },
            { items: [] },
        ],
        sourceLocation: dummySourceLocation,
        type: 'asAndBs',
    });

    const twobs: any = parse(testGrammar, 'asAndBs', [
        { type: 'b', string: 'b', sourceLocation: dummySourceLocation },
        { type: 'b', string: 'b', sourceLocation: dummySourceLocation },
    ]);
    t.deepEqual(twobs, {
        children: [
            { items: [] },
            {
                items: [
                    { type: 'b', value: undefined, sourceLocation: dummySourceLocation },
                    { type: 'b', value: undefined, sourceLocation: dummySourceLocation },
                ],
            },
        ],
        sourceLocation: dummySourceLocation,
        type: 'asAndBs',
    });

    const aThenB: any = parse(testGrammar, 'asAndBs', [
        { type: 'a', string: 'a', sourceLocation: dummySourceLocation },
        { type: 'b', string: 'b', sourceLocation: dummySourceLocation },
    ]);
    t.deepEqual(aThenB, {
        children: [
            {
                items: [{ sourceLocation: dummySourceLocation, type: 'a', value: undefined }],
            },
            {
                items: [{ sourceLocation: dummySourceLocation, type: 'b', value: undefined }],
            },
        ],
        sourceLocation: dummySourceLocation,
        type: 'asAndBs',
    });

    const aba: any = parse(testGrammar, 'asAndBs', [
        { type: 'a', string: 'a', sourceLocation: dummySourceLocation },
        { type: 'b', string: 'b', sourceLocation: dummySourceLocation },
        { type: 'a', string: 'a', sourceLocation: dummySourceLocation },
    ]);
    t.deepEqual(aba, {
        kind: 'parseError',
        errors: [
            {
                expected: 'endOfFile',
                found: 'a',
                foundTokenText: 'a',
                sourceLocation: dummySourceLocation,
                whileParsing: ['asAndBs'],
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
            destination: new Register('d'),
            lhs: new Register('l'),
            rhs: new Register('r'),
            kind: 'add',
            why: '\n',
        },
        {
            destination: new Register('r'),
            lhs: new Register('l2'),
            rhs: new Register('d'),
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
            function: new Register('fn'),
            arguments: [new Register('arg')],
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
            function: new Register('fn'),
            arguments: [new Register('arg')],
            destination: new Register('result'),
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

    const tokens: Token<TestToken>[] = [
        { type: 'xToken', string: 'xToken', sourceLocation: { line: 0, column: 0 } },
    ];
    const ast = parse(testGrammar, 'x', tokens);
    t.deepEqual(stripSourceLocation(ast), {
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

test('Assign Registers for Old For', t => {
    const f = parseFunctionOrDie(`
        (function) main():
            ; 4b for length, 3 8b items
            r:dataPointer_3 = my_malloc(28); allocate
            r:listLength_4 = 3; save size
            *(r:dataPointer_3 + 0) = r:listLength_4; save list length
            r:assignment_rhs_2 = r:dataPointer_3; save memory for pointer
            r:item_0_5 = 1; Load number litera
            *(r:dataPointer_3 + 4) = r:item_0_5; Store this item in the list
            r:item_1_6 = 2; Load number litera
            *(r:dataPointer_3 + 8) = r:item_1_6; Store this item in the list
            r:item_2_7 = 3; Load number litera
            *(r:dataPointer_3 + 12) = r:item_2_7; Store this item in the list
            r:remainingCount_8 = *(r:assignment_rhs_2 + 0); Get length of list
            r:sourceAddress_11 = r:assignment_rhs_2; Local copy of source data pointer
            r:itemSize_10 = 4; For multiplying
            r:remainingCount_8 = r:remainingCount_8 * r:itemSize_10; Count = count * size
            r:remainingCount_8 += 4; Add place to store length of list
            r:targetAddress_9 = my_malloc(r:remainingCount_8); Malloc
            *numbers_1 = r:targetAddress_9; Store to global
        copyLoop_1:; Copy loop
            r:temp_12 = *(r:sourceAddress_11 + 0); Copy a byte
            *(r:targetAddress_9 + 0) = r:temp_12; Finish copy
            r:remainingCount_8 += -4; Bump pointers
            r:sourceAddress_11 += 4; Bump pointers
            r:targetAddress_9 += 4; Bump pointers
            goto copyLoop_1 if r:remainingCount_8 != 0; Not done
            my_free(r:dataPointer_3); free temporary list
            r:assignment_rhs_13 = 0; Load number litera
            *sum_2 = r:assignment_rhs_13; Put Integer into globa
            r:list_16 = sum_2; Load sum from global into register
        loop_2:; loop
            r:index_14++; i++
            goto loop_2 if r:index_14 != r:max_15; not done
            r:result_20 = sum_2; Load sum from global into register
            return r:result_20;; Return previous expressio
    `);
    assignRegisters(f, ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8']);
    t.pass();
});

test.failing('Register assignment for Many Globals Multiply', t => {
    const f = parseFunctionOrDie(`
        (function) main():
            r:ri = &readInt; Load runtime function
            r:assignment_rhs_ = r:ri();
            *var_1_ = r:assignment_rhs_; Put Integer into global
            r:assignment_rhs_1 = r:ri();
            *var_2_ = r:assignment_rhs_1; Put Integer into global
            r:assignment_rhs_2 = r:ri();
            *var_3_ = r:assignment_rhs_2; Put Integer into global
            r:assignment_rhs_3 = r:ri();
            *var_4_ = r:assignment_rhs_3; Put Integer into global
            r:assignment_rhs_4 = r:ri();
            *var_5_ = r:assignment_rhs_4; Put Integer into global
            r:assignment_rhs_5 = r:ri();
            *var_6_ = r:assignment_rhs_5; Put Integer into global
            r:assignment_rhs_6 = r:ri();
            *var_7_ = r:assignment_rhs_6; Put Integer into global
            r:assignment_rhs_7 = r:ri();
            *var_8_ = r:assignment_rhs_7; Put Integer into global
            r:assignment_rhs_8 = r:ri();
            *var_9_ = r:assignment_rhs_8; Put Integer into global
            r:assignment_rhs_9 = r:ri();
            *var_10_ = r:assignment_rhs_9; Put Integer into global
            r:assignment_rhs_10 = r:ri();
            *var_11_ = r:assignment_rhs_10; Put Integer into global
            r:assignment_rhs_11 = r:ri();
            *var_12_ = r:assignment_rhs_11; Put Integer into global
            r:assignment_rhs_12 = r:ri();
            *var_13_ = r:assignment_rhs_12; Put Integer into global
            r:assignment_rhs_13 = r:ri();
            *var_14_ = r:assignment_rhs_13; Put Integer into global
            r:assignment_rhs_14 = r:ri();
            *var_15_ = r:assignment_rhs_14; Put Integer into global
            r:assignment_rhs_15 = r:ri();
            *var_16_ = r:assignment_rhs_15; Put Integer into global
            r:product_lhs_1 = var_1_; Load var_1 from global into register
            r:product_rhs_1 = var_2_; Load var_2 from global into register
            r:product_lhs_ = r:product_lhs_1 * r:product_rhs_1; Evaluate product
            r:product_lhs_3 = var_3_; Load var_3 from global into register
            r:product_rhs_3 = var_4_; Load var_4 from global into register
            r:product_lhs_2 = r:product_lhs_3 * r:product_rhs_3; Evaluate product
            r:product_lhs_5 = var_5_; Load var_5 from global into register
            r:product_rhs_5 = var_6_; Load var_6 from global into register
            r:product_lhs_4 = r:product_lhs_5 * r:product_rhs_5; Evaluate product
            r:product_lhs_7 = var_7_; Load var_7 from global into register
            r:product_rhs_7 = var_8_; Load var_8 from global into register
            r:product_lhs_6 = r:product_lhs_7 * r:product_rhs_7; Evaluate product
            r:product_lhs_9 = var_9_; Load var_9 from global into register
            r:product_rhs_9 = var_10_; Load var_10 from global into register
            r:product_lhs_8 = r:product_lhs_9 * r:product_rhs_9; Evaluate product
            r:product_lhs_11 = var_11_; Load var_11 from global into register
            r:product_rhs_11 = var_12_; Load var_12 from global into register
            r:product_lhs_10 = r:product_lhs_11 * r:product_rhs_11; Evaluate product
            r:product_lhs_13 = var_13_; Load var_13 from global into register
            r:product_rhs_13 = var_14_; Load var_14 from global into register
            r:product_lhs_12 = r:product_lhs_13 * r:product_rhs_13; Evaluate product
            r:product_lhs_15 = var_15_; Load var_15 from global into register
            r:product_rhs_15 = var_16_; Load var_16 from global into register
            r:product_lhs_14 = r:product_lhs_15 * r:product_rhs_15; Evaluate product
            r:product_lhs_17 = var_17_; Load var_17 from global into register
            r:product_lhs_16 = r:product_lhs_17 * r:product_rhs_17; Evaluate product
            r:product_rhs_14 = r:product_lhs_16 * r:product_rhs_16; Evaluate product
            r:product_rhs_12 = r:product_lhs_14 * r:product_rhs_14; Evaluate product
            r:product_rhs_10 = r:product_lhs_12 * r:product_rhs_12; Evaluate product
            r:product_rhs_8 = r:product_lhs_10 * r:product_rhs_10; Evaluate product
            r:product_rhs_6 = r:product_lhs_8 * r:product_rhs_8; Evaluate product
            r:product_rhs_4 = r:product_lhs_6 * r:product_rhs_6; Evaluate product
            r:product_rhs_2 = r:product_lhs_4 * r:product_rhs_4; Evaluate product
            r:product_rhs_ = r:product_lhs_2 * r:product_rhs_2; Evaluate product
            r:result_ = r:product_lhs_ * r:product_rhs_; Evaluate product
            return r:result_;; Return previous expressio
    `);
    const rds = ['$t1', '$t2', '$t3', '$t4', '$t5', '$t6', '$t7', '$t8', '$t9'];
    const assigned = assignRegisters(f, rds);
    t.assert('product_lhs_1' in assigned.assignment);
});

// Regression test from when I broke this
test('add/increment are writes', t => {
    const f = parseFunctionOrDie(`
        (function) main():
            r:count = 0; Init
            r:count += 4; Add
            r:count++; Increment
            return r:count;
    `);
    const rds = removeDeadStores(f, tafLiveness(f));
    t.assert(rds === undefined); // undefined means nothing was removed
});

// Regression test from before we used hasSideEffects and used shitty heuristics for determining whether an instruction had side effects.
test("Functions calls with side effects don't get removed for being dead", t => {
    const f: Function = {
        name: 'anonymous_1',
        instructions: [
            {
                kind: 'loadSymbolAddress',
                symbolName: 'string_literal_1_Hello',
                to: new Register('local_a'),
                why: 'Load string literal addres',
            },
            {
                kind: 'move',
                from: new Register('local_a'),
                to: new Register('argument0'),
                why: 'Move from a into destination',
            },
            { kind: 'empty', why: 'call print' },
            {
                kind: 'loadSymbolAddress',
                symbolName: 'print',
                to: new Register('function_pointer_7'),
                why: 'Load runtime function',
            },
            {
                kind: 'callByRegister' as 'callByRegister',
                function: new Register('function_pointer_7'),
                arguments: [new Register('argument0')],
                destination: new Register('local_dummy_3'),
                why: 'Call runtime print',
            },
        ],
        liveAtExit: [new Register('exitCodeRegister_1')],
        arguments: [],
    };
    const assigned = assignRegisters(f, [
        new Register('r1'),
        new Register('r2'),
        new Register('r3'),
    ]);
    t.assert('argument0' in assigned.assignment.registerMap);
});

// Regression test for when I accidentally removes all control flow bucause control flow doesn't change registers.
test("Control flow instructions don't get removed for having no writes", t => {
    const f: Function = {
        name: 'verify_no_leaks',
        instructions: [
            {
                kind: 'loadImmediate',
                destination: new Register('one'),
                value: 1,
                why: 'Need for comparison',
            },
            {
                kind: 'loadImmediate',
                destination: new Register('two'),
                value: 2,
                why: 'Need for comparison',
            },
            {
                kind: 'gotoIfEqual',
                label: 'L',
                lhs: new Register('two'),
                rhs: new Register('one'),
                why: 'comparison',
            },
            {
                kind: 'label',
                name: 'L',
                why: 'L',
            },
        ],
        liveAtExit: [],
        arguments: [],
    };
    const assigned = assignRegisters(f, [{ name: 'r1' }, { name: 'r2' }, { name: 'r3' }]);
    t.assert('one' in assigned.assignment.registerMap);
    t.assert('two' in assigned.assignment.registerMap);
});

test('functionToString', t => {
    const f: Function = {
        name: 'main',
        instructions: [
            {
                kind: 'callByName',
                function: 'my_malloc',
                arguments: [28],
                destination: {
                    name: 'dataPointer_3',
                },
                why: 'allocate',
            },
        ],
        liveAtExit: [],
        arguments: [],
    };
    t.deepEqual(
        functionToString(f),
        `(function) main():
    r:dataPointer_3 = my_malloc(28); allocate`
    );
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

test('Unique Cmp', t => {
    t.deepEqual(
        uniqueCmp((a, b) => a == b, ['a', 'a', 'a']),
        ['a']
    );
    t.deepEqual(
        uniqueCmp((a, b) => a == b, ['a', 'b', 'a']),
        ['a', 'b']
    );
});

test('Unique By', t => {
    t.deepEqual(
        uniqueBy(a => a, ['a', 'a', 'a']),
        ['a']
    );
    t.deepEqual(
        uniqueBy(a => a, ['a', 'b', 'a']),
        ['a', 'b']
    );
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
