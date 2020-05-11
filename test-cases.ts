import { TestProgram, TestModule } from './test-case';
import join from './util/join';
import range from './util/list/range';
import { builtinTypes } from './types';

const manyGlobalsMultiply = () => {
    const numbers = range(1, 20);
    const createVars = join(
        numbers.map(i => `var_${i} := readInt();`),
        '\n'
    );
    const multiplyVars = join(
        numbers.map(i => `var_${i}`),
        ' * '
    );
    const stdin = join(
        numbers.map(i => `1\n`),
        ''
    );
    return {
        name: 'Many Globals Multiply',
        source: `
            ${createVars}
            return ${multiplyVars};
        `,
        exitCode: 1,
        stdin,
        failing: true,
    };
};

export const testModules: TestModule[] = [
    {
        name: 'Exported Function',
        source: 'export constThree := a: Integer => 3;',
        resultJs: `
                const anonymous_1 = (a) => { return  3 }
                export const constThree = anonymous_1;
            `,
    },
    {
        name: 'Add Functions',
        source: 'export add := (a: Integer, b: Integer) => a + b;',
        resultJs: `
                const anonymous_1 = (a, b) => { return  a + b }
                export const add = anonymous_1;
            `,
    },
    {
        name: 'Exported Integer',
        source: 'export three := 3;',
        resultJs: 'export const three = 3;',
        failing: true, // TODO: Export constants
    },
];

export const testPrograms: TestProgram[] = [
    { name: 'Bare Return', source: 'return 7;', exitCode: 7 },
    { name: 'Single Product', source: 'return 2 * 2;', exitCode: 4 },
    { name: 'Brackets', source: 'return (3);', exitCode: 3 },
    {
        name: 'Double Product with Brackets',
        source: 'return 2 * (3 * 4) * 5;',
        exitCode: 120,
        ast: {
            type: 'program',
            children: [
                {
                    type: 'statement',
                    children: [
                        {
                            type: 'returnStatement',
                            children: [
                                { type: 'return', value: null },
                                {
                                    type: 'product',
                                    children: [
                                        {
                                            type: 'product',
                                            children: [
                                                { type: 'number', value: 2 },
                                                { type: 'product', value: null },
                                                {
                                                    type: 'product',
                                                    children: [
                                                        { type: 'number', value: 3 },
                                                        { type: 'product', value: null },
                                                        { type: 'number', value: 4 },
                                                    ],
                                                },
                                            ],
                                        },
                                        { type: 'product', value: null },
                                        { type: 'number', value: 5 },
                                    ],
                                },
                            ],
                        },
                        { type: 'statementSeparator', value: null },
                    ],
                },
            ],
        },
    },
    {
        name: 'Unused Function',
        source: 'constThree := a: Integer => 3; return 10;',
        exitCode: 10,
    },
    {
        name: 'Export in Non-Module',
        source: `
            export three := 3;
            return 7;
        `,
        typeErrors: [
            { kind: 'topLevelStatementsInModule', sourceLocation: { column: 13, line: 3 } },
        ],
    },
    {
        name: 'Used Function',
        source: 'takeItToEleven := a: Integer => 11; return takeItToEleven(0);',
        exitCode: 11,
    },
    {
        name: 'Recursive Function',
        source: `
            factorial := x: Integer => x == 1 ? 1 : x * factorial(x - 1);
            return factorial(5);
        `,
        exitCode: 120,
    },
    {
        name: 'Multiple Used Functions',
        source: `
const11 := a: Integer => 11;
const12 := a: Integer => 12;
return const11(1) * const12(2);
`,
        exitCode: 132,
    },
    {
        name: 'String Concatenation',
        source: `
str1: String = "a";
str2: String = "b";
return str1 ++ str2 == "ab" ? 5 : 10;
`,
        exitCode: 5,
    },
    {
        name: 'Semi-Complex String Concatenation',
        source: `
lenFunc := dummy: Integer => {
    str1 := "abc";
    str2 := str1 ++ str1;
    return str2 == "abcabc" ? 40 : 50;
};
return lenFunc(5);
`,
        exitCode: 40,
    },
    {
        name: 'Self Multiply and Assign',
        source: `
a: Integer = 3;
a = a * a;
return a;
`,
        exitCode: 9,
    },
    {
        name: 'Function Returns Boolean',
        source: `
isFive: Function<Integer, Boolean> = a: Integer => a == 5;
return isFive(5) ? 1 : 0;`,
        exitCode: 1,
    },
    {
        name: 'Ternary False',
        source: 'return 0 == 1 ? 5 : 6;',
        exitCode: 6,
    },
    {
        name: 'String Copy',
        source: `myStr1: String = "testing"; myStr2: String = myStr1; return length(myStr2);`,
        exitCode: 7,
    },
    {
        name: 'String assignment inside function',
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
        stdout: 'HelloWorld!!!!!',
    },
    {
        name: 'Print',
        // TODO: print() maybe shouldn't return anything? Or return on error?
        source: `
            dummy := print("sample_string");
            return 1;
        `,
        exitCode: 1,
        stdout: 'sample_string',
    },
    {
        name: 'Complex String Concatenation',
        source: `
            lenFunc := dummy: Integer => {
                str1 := "abc";
                str2 := "def";
                str3 := "abc";
                concat1 := str1 ++ str2 ++ str3;
                concat2 := str3 ++ str2 ++ str3;
                return concat1 == concat2 ? (length(str1 ++ str2)) : 99;
            };
            return lenFunc(5);
        `,
        exitCode: 6,
        infiniteLooping: true,
        failing: true,
    },
    {
        name: 'No Args',
        source: `
            const11 := () => 11;
            return const11();
        `,
        exitCode: 11,
    },
    {
        name: 'No Return',
        source: 'const11 := () => 11;',
        exitCode: 1,
        failing: true, // TODO: should be a syntax error (no return)
    },
    {
        name: 'Read Integer',
        source: `
            val := readInt();
            return val;
        `,
        stdin: '5',
        exitCode: 5,
    },
    {
        // TODO: Errors/sum types
        name: 'Read Integer Errors on Empty Input',
        source: `
            val := readInt();
            return val;
        `,
        stdin: '',
        exitCode: 5, // TODO select an exit code
        failing: true,
    },
    {
        name: 'Should leak',
        source: `
            __internal_leak_memory();
            return 0;
        `,
        exitCode: -1,
        stdout: 'Leaks found',
        failing: true,
    },
    {
        name: 'Missing Semicolon',
        source: `
            foo = () => {
                return 1;
            }
            return foo();
        `,
        parseErrors: [
            {
                expected: 'statementSeparator',
                found: 'return',
                sourceLocation: { line: 4, column: 13 },
            },
        ],
    },
    manyGlobalsMultiply(),
    {
        name: 'Zero Item List',
        source: `
            myList: Boolean[] = [];
            return length(myList);
        `,
        exitCode: 0,
        failing: true, // TODO: Length currently only for strings :(
    },
    {
        name: 'Explicitly Typed List',
        source: `
            myList: Boolean[] = [true];
            return myList[0] ? 1 : 2;
        `,
        exitCode: 1,
    },
    {
        name: 'Untyped Zero Item List',
        source: `
            myList := [];
            return length(myList);
        `,
        exitCode: 0,
        failing: true, // expect a type error
    },
    {
        name: 'Wrong Type List',
        source: `
            myList: Boolean[] = [5];
            return myList[0] ? 1 : 2;
        `,
        exitCode: 0,
        typeErrors: [
            {
                kind: 'assignWrongType',
                lhsName: 'myList',
                lhsType: { type: { kind: 'List', of: { type: { kind: 'Boolean' } } } },
                rhsType: { type: { kind: 'List', of: { type: { kind: 'Integer' } } } },
                sourceLocation: { column: 13, line: 2 },
            },
        ],
    },
    {
        name: 'One Item List',
        source: `
            myList := [11];
            return myList[0];
        `,
        exitCode: 11,
    },
    {
        name: 'Two Item List',
        source: `
            myList := [11, 22];
            return myList[0] + myList[1];
        `,
        exitCode: 33,
    },
    {
        name: 'List Out Of Bounds Access',
        source: `
            myList := [11, 22];
            return myList[2];
        `,
        exitCode: 0,
        failing: true,
    },
    {
        name: 'Bool Pair',
        source: `
            BoolPair := {
                first: Boolean;
                second: Boolean;
            };
            bp: BoolPair = BoolPair { first: true, second: false, };
            return bp.first ? 10 : 20;
        `,
        exitCode: 10,
    },
    {
        name: 'Int Pair',
        source: `
            IntPair := {
                first: Integer;
                second: Integer;
            };
            ip: IntPair = IntPair { first: 3, second: 7, };
            return ip.first * ip.second;
        `,
        exitCode: 21,
    },
    {
        name: 'Int Pair in Function',
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

            return foo();
        `,
        exitCode: 34 - 12,
    },
    {
        name: 'Multiple Int Pairs in Function',
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
    },
    {
        name: 'Return Int Pair',
        source: `
            IntPair := {
                first: Integer;
                second: Integer;
            };

            returnsIntPair: Function<IntPair> = () => {
                ip := IntPair {
                    first: 12,
                    second: 34,
                };
                return ip;
            };

            resultVar: IntPair = returnsIntPair();
            return resultVar.second - resultVar.first;
        `,
        exitCode: 34 - 12,
    },
    {
        name: 'Return Int Pair Twice',
        source: `
            IntPair := {
                first: Integer;
                second: Integer;
            };

            returnsIntPair: Function<IntPair> = () => {
                ip := IntPair {
                    first: 12,
                    second: 34,
                };
                return ip;
            };

            result1: IntPair = returnsIntPair();
            midVar := 2;
            result2: IntPair = returnsIntPair();
            return result1.second - result2.first - midVar;
        `,
        exitCode: 34 - 12 - 2,
    },
    {
        name: 'Return List',
        source: `
            returnsList := () => {
                return [1,2,3,4,5,6,7];
            };
            l := returnsList();
            return l[3];
        `,
        exitCode: 4,
    },
    {
        name: 'Temporary List',
        source: `
            returnsList := () => {
                return [1,2,3,4,5,6,7];
            };
            return returnsList()[3];
        `,
        exitCode: 4,
        failing: true,
    },
    {
        name: 'String Length',
        source: `
            myStr: String = "test";
            return length(myStr);
        `,
        exitCode: 4,
    },
    {
        name: 'Empty String Length',
        source: `
            myStr: String = "";
            return length(myStr);
        `,
        exitCode: 0,
    },
    {
        name: 'String Length as Member',
        source: `
            myStr: String = "test";
            return myStr.length();
        `,
        exitCode: 4,
    },
    {
        name: 'Seven Argument Function',
        source: `
            foo := (a: Integer, b: Integer, c: Integer, d: Integer, e: Integer, f: Integer, g: Integer) => {
                return a + b + c + d + e + f + g;
            };
            return foo(1, 2, 3, 4, 5, 6, 7);
        `,
        exitCode: 28,
    },
    {
        name: 'Id Function',
        source: `
            id := a: Integer => a; return id(5);
        `,
        exitCode: 5,
    },
    {
        name: 'Reassign String',
        source: `
            a := "Hello";
            dummy := print(a);
            a = "World!!!!!";
            dummy = print(a);
            return dummy - dummy;
        `,
        exitCode: 0,
        stdout: 'HelloWorld!!!!!',
    },
    {
        name: 'Allocate in Ternary True',
        source: `
            foo := a: Boolean => {
                str1 := "a";
                str2 := "b";
                return a ? length(str1 ++ str2) : 0;
            };
            return foo(true);
        `,
        exitCode: 2,
    },
    {
        name: 'Allocate in Ternary False',
        source: `
            foo := a: Boolean => {
                str1 := "a";
                str2 := "b";
                return a ? 0 : length(str1 ++ str2);
            };
            return foo(false);
        `,
        exitCode: 2,
    },
    {
        name: 'Skipped Allocate in Ternary True',
        source: `
            foo := a: Boolean => {
                str1 := "a";
                str2 := "b";
                return a ? length(str1 ++ str2) : 0;
            };
            return foo(false);
        `,
        exitCode: 0,
    },
    {
        name: 'Skipped Allocate in Ternary False',
        source: `
            foo := a: Boolean => {
                str1 := "a";
                str2 := "b";
                return a ? 0 : length(str1 ++ str2);
            };
            return foo(true);
        `,
        exitCode: 0,
    },
    {
        name: 'String Equality: Equal',
        source: `str1 := "a";
            str2 := "a";
            return str1 == str2 ? 1 : 2;
        `,
        exitCode: 1,
    },
    {
        name: 'Write to Argument',
        source: `
            foo := a: Boolean => {
                a = False;
                return 0;
            };
            return foo(true);
        `,
        exitCode: 0,
        failing: true, // TODO: should error about assigning to argument
    },
    {
        name: 'Return String',
        source: `
            isFive: Function<Integer, String> = a: Integer => a == 5 ? "isFive" : "isNotFive";
            return length(isFive(5));
        `,
        exitCode: 6,
    },
    {
        name: 'Reassign Integer Inside Function',
        source: `
            foo := () => {
                a := 1;
                b := a + 5;
                a = 2;
                c := a + b;
                return c;
            };
            return foo();
        `,
        exitCode: 8,
    },
    {
        name: 'Function Named Times',
        source: `
            times := (a: Integer, b: Integer) => a * b;
            return times(11, 1);
        `,
        exitCode: 11,
    },
    {
        name: 'Variable Named Result',
        source: `
            foo := () => {
                result := 10;
                return result;
            };
            return foo();
        `,
        exitCode: 10,
        failing: true,
    },
    {
        name: 'Variable Named Like Keyword',
        source: `
            returnVar := 5;
            exportVar := 6;
            return returnVar + exportVar;
        `,
        exitCode: 11,
    },
    {
        name: 'Assign Function to Wrong Args Number',
        source: `
            myFunc: Function<Integer, Integer> = () => 111;
            return 0;
        `,
        typeErrors: [
            {
                kind: 'assignWrongType',
                lhsName: 'myFunc',
                lhsType: {
                    type: {
                        kind: 'Function',
                        arguments: [builtinTypes.Integer],
                        returnType: builtinTypes.Integer,
                    },
                },
                rhsType: {
                    type: {
                        kind: 'Function',
                        arguments: [],
                        permissions: [],
                        returnType: builtinTypes.Integer,
                    },
                },
                sourceLocation: { line: 2, column: 13 },
            },
        ],
    },
    {
        name: 'Assign Function to Wrong Args Type',
        source: `
            myFunc: Function<Integer, Integer> = (a: String) => 111;
            return myFunc("");
        `,
        typeErrors: [
            {
                kind: 'assignWrongType',
                lhsName: 'myFunc',
                lhsType: {
                    type: {
                        kind: 'Function',
                        arguments: [builtinTypes.Integer],
                        returnType: builtinTypes.Integer,
                    },
                },
                rhsType: {
                    type: {
                        kind: 'Function',
                        arguments: [builtinTypes.String],
                        permissions: [],
                        returnType: builtinTypes.Integer,
                    },
                },
                sourceLocation: { line: 2, column: 13 },
            },
        ],
    },
    {
        name: 'Assign Function to Wrong Return Type',
        source: `
            myFunc: Function<Integer, Boolean> = (a: String) => 111;
            return myFunc("");
        `,
        typeErrors: [
            {
                kind: 'assignWrongType',
                lhsName: 'myFunc',
                lhsType: {
                    type: {
                        kind: 'Function',
                        arguments: [builtinTypes.Integer],
                        returnType: builtinTypes.Boolean,
                    },
                },
                rhsType: {
                    type: {
                        kind: 'Function',
                        arguments: [builtinTypes.String],
                        permissions: [],
                        returnType: builtinTypes.Integer,
                    },
                },
                sourceLocation: { line: 2, column: 13 },
            },
        ],
    },
    {
        name: 'For',
        source: `
            numbers := [1, 2, 3];
            sum := 0;
            for (number : sum) {
                sum = sum + number;
            };
            return sum;
        `,
        exitCode: 6,
    },
];
