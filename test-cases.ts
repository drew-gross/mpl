import { TestModule } from './test-case';
import join from './util/join';
import range from './util/list/range';
import { builtinTypes, Function as FunctionType, List } from './types';
import { ExecutionResult } from './api';

export type TestProgram = {
    name: string;
    source: string;
    failingBackends?: string | string[]; // Expect this to fail
    infiniteLooping?: boolean; // Don't even attempt to compile this, it will infinite loop
    failingInterpreter?: boolean; // Fails to interpret in a way that fucks with the debugger

    // Expected results of test
    exitCode?: number;
    stdout?: string;
    parseErrors?: any[];
    typeErrors?: any[];
    ast?: any;

    // Runtime inputs to test
    stdin?: string;
};

export const passed = (testCase: TestProgram, result: ExecutionResult) => {
    if ('error' in result) return false;
    if (testCase.exitCode != result.exitCode) return false;
    if (
        'stdout' in testCase &&
        testCase.stdout !== undefined &&
        testCase.stdout != result.stdout
    )
        return false;
    return true;
};

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
        numbers.map(_i => `1\n`),
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
        infiniteLooping: true,
    };
};

export const testModules: TestModule[] = [
    {
        name: 'Exported Function',
        source: 'export constThree := a: Integer => 3;',
        resultJs: `
const anonymous_1 = (a) => {
  return 3;
};
export const constThree = anonymous_1;
`,
    },
    {
        name: 'Add Functions',
        source: 'export add := (a: Integer, b: Integer) => a + b;',
        resultJs: `
const anonymous_1 = (a, b) => {
  return a + b;
};
export const add = anonymous_1;
`,
    },
    {
        name: 'Exported Integer',
        source: 'export three := 3;',
        resultJs: 'export const three = 3;',
        failing: true, // TODO: Export constants
    },
    {
        name: 'Sum',
        source: `
            export sum := (xs: Integer[]) => {
                result := 0;
                for (x : xs) {
                    result = result + x;
                };
                return result;
            };
        `,
        resultJs: `
const anonymous_1 = (xs) => {
  let result = 0;
  const items = xs;
  for (let i = 0; i < items.length; i++) {
    const x = items[i];
    result = result + x;
  }
  return result;
};
export const sum = anonymous_1;
`,
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
            seqeunceItems: [
                {
                    type: 'statement',
                    seqeunceItems: [
                        {
                            type: 'returnStatement',
                            seqeunceItems: [
                                { type: 'return', value: null },
                                {
                                    type: 'product',
                                    seqeunceItems: [
                                        {
                                            type: 'product',
                                            seqeunceItems: [
                                                { type: 'number', value: 2 },
                                                { type: 'product', value: null },
                                                {
                                                    type: 'product',
                                                    seqeunceItems: [
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
        failingInterpreter: true,
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
        failingInterpreter: true,
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
        name: 'Multiply by Literal',
        source: `
            a: Integer = 2;
            b := a * 4;
            return b;
        `,
        exitCode: 8,
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
        // TODO: should be a syntax error (no return)
        name: 'No Return',
        source: 'const11 := () => 11;',
        exitCode: 1,
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
    },
    {
        name: 'Should leak',
        source: `
            __internal_leak_memory();
            return 0;
        `,
        exitCode: -1,
        stdout: 'Leaks found',
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
                sourceLocation: { line: 5, column: 13 },
            },
        ],
    },
    manyGlobalsMultiply(),
    {
        // TODO: Length currently only for strings :(
        name: 'Zero Item List',
        source: `
            myList: Boolean[] = [];
            return length(myList);
        `,
        exitCode: 0,
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
        // expect a type error
        name: 'Untyped Zero Item List',
        source: `
            myList := [];
            return length(myList);
        `,
        exitCode: 0,
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
                lhsType: List(builtinTypes.Boolean),
                rhsType: List(builtinTypes.Integer),
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
        failingInterpreter: true,
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
        name: 'Function Accepts List',
        source: `
            acceptsList := (xs: Integer[]) => {
                return 3;
            };
            xs := [1];
            return acceptsList(xs);
        `,
        exitCode: 3,
    },
    {
        name: 'Function Accepts Temporary List',
        source: `
            acceptsList := (xs: Integer[]) => {
                return 3;
            };
            return acceptsList([1]);
        `,
        exitCode: 3,
    },
    {
        name: 'List Out Of Bounds Access',
        source: `
            myList := [11, 22];
            return myList[2];
        `,
        exitCode: 0,
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
        failingInterpreter: true,
    },
    {
        name: 'Define Int Pair',
        source: `
            IntPair := {
                first: Integer;
                second: Integer;
            };
            return 1;
        `,
        exitCode: 1,
    },
    {
        name: 'Use Int Pair',
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
        name: 'Int Pair With Methods',
        source: `
            IntPair := {
                first: Integer;
                second: Integer;
                firstPlusSecond() {
                    retrun this.first + this.second;
                };
            };
            ip: IntPair = IntPair { first: 3, second: 7, };
            return ip.firstPlusSecond();
        `,
        exitCode: 11,
    },
    {
        name: 'Int Pair With Methods With Args',
        source: `
            IntPair := {
                first: Integer;
                second: Integer;
                firstPlusSecondPlusArg(addThis: Integer) {
                    retrun this.first + this.second;
                };
            };
            ip: IntPair = IntPair { first: 3, second: 7, };
            return ip.firstPlusSecond(15);
        `,
        exitCode: 26,
    },
    {
        name: 'List of Pairs',
        source: `
            IntPair := {
                first: Integer;
                second: Integer;
            };
            ipList: IntPair[] = [
                IntPair { first: 1, second: 2, },
                IntPair { first: 3, second: 4, }
            ];
            elem: IntPair = ipList[1];
            return elem.second;
        `,
        exitCode: 4,
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
        failingInterpreter: true,
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
        failingInterpreter: true,
    },
    {
        name: 'String Length',
        source: `
            myStr: String = "test";
            return length(myStr);
        `,
        exitCode: 4,
        failingInterpreter: true,
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
        name: 'String Startswith Success',
        source: `
            myStr: String = "test";
            return myStr.startsWith("te") ? 10 : 9;
        `,
        exitCode: 10,
    },
    {
        name: 'String Startswith Fail',
        source: `
            myStr: String = "test";
            return myStr.startsWith("nope") ? 9 : 10;
        `,
        exitCode: 10,
    },
    {
        name: 'String Startswith Empty Needle',
        source: `
            myStr: String = "test";
            return myStr.startsWith("") ? 10 : 9;
        `,
        exitCode: 10,
    },
    {
        name: 'String Startswith Empty Haystack',
        source: `
            myStr: String = "";
            return myStr.startsWith("test") ? 9 : 10;
        `,
        exitCode: 10,
    },
    {
        // Failing on x64, Need to fix x64 stack layout BS (after fixing all of x64?)
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
        name: 'Nine Argument Function With Multiply',
        source: `
            foo := (a: Integer, b: Integer, c: Integer, d: Integer, e: Integer, f: Integer, g: Integer, h: Integer, i: Integer) => {
                return a * b * c * d * e * f * g * h * i;
            };
            return foo(1, 1, 1, 2, 3, 2, 1, 2, 3);
        `,
        exitCode: 72,
        // TODO: Probably need to implement left recursion elimination for this to work
        infiniteLooping: true,
    },
    {
        name: 'Seven Argument Function With Subtract',
        source: `
            foo := (a: Integer, b: Integer, c: Integer, d: Integer, e: Integer, f: Integer, g: Integer) => {
                return a - b - c - d - e - f - g;
            };
            return foo(10, 1, 1, 1, 1, 1, 1);
        `,
        exitCode: 4,
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
        // TODO: should error about assigning to argument
        name: 'Write to Argument',
        source: `
            foo := a: Boolean => {
                a = False;
                return 0;
            };
            return foo(true);
        `,
        exitCode: 1,
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
        name: 'Reserved Name',
        source: `
            foo := () => {
                rrresult := 10;
                return rrresult;
            };
            return foo();
        `,
        exitCode: 10,
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
                lhsType: FunctionType([builtinTypes.Integer], [], builtinTypes.Integer),
                rhsType: FunctionType([], [], builtinTypes.Integer),
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
                lhsType: FunctionType([builtinTypes.Integer], [], builtinTypes.Integer),
                rhsType: FunctionType([builtinTypes.String], [], builtinTypes.Integer),
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
                lhsType: FunctionType([builtinTypes.Integer], [], builtinTypes.Boolean),
                rhsType: FunctionType([builtinTypes.String], [], builtinTypes.Integer),
                sourceLocation: { line: 2, column: 13 },
            },
        ],
    },
    {
        name: 'Reassign to Undeclared Identifier Inside Function',
        source: `
            foo := () => {
                a := 1;
                b = 2;
                return a + b;
            };
            return foo();
        `,
        typeErrors: [
            {
                kind: 'assignUndeclaredIdentifer',
                destinationName: 'b',
                sourceLocation: { line: 4, column: 17 },
            },
            {
                kind: 'unknownTypeForIdentifier',
                identifierName: 'b',
                sourceLocation: { line: 5, column: 28 },
            },
        ],
    },
    {
        name: 'For',
        source: `
            numbers := [1, 2, 3];
            sum := 0;
            for (number : numbers) {
                sum = sum + number;
            };
            return sum;
        `,
        exitCode: 6,
        failingInterpreter: true,
    },
    {
        name: 'Large For',
        source: `
            numbers := [1, 2, 3, 2, 1, 2, 3];
            sum := 10;
            for (number : numbers) {
                sum = sum + number;
            };
            return sum;
        `,
        exitCode: 24,
    },
    {
        name: 'For With Non-Iterable',
        source: `
            sum := 0;
            for (number : sum) {
                sum = sum + number;
            };
            return sum;
        `,
        typeErrors: [
            {
                kind: 'nonListInFor',
                found: builtinTypes.Integer,
                sourceLocation: { line: 3, column: 13 },
            },
        ] as any,
    },
    {
        name: 'For in Function',
        source: `
            sum := () => {
                xs := [3, 4, 5];
                result := 0;
                for (x : xs) {
                    result = result + x;
                };
                return result;
            };
            return sum();
        `,
        exitCode: 12,
        failingInterpreter: true,
    },
    {
        // TODO: rewrite this in a way that it is guaranteed to cause spilling
        name: 'Stack depth 2 with spilling',
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
    },
    {
        name: 'double product',
        source: 'return 5 * 3 * 4;',
        exitCode: 60,
        ast: {
            type: 'program',
            seqeunceItems: [
                {
                    type: 'statement',
                    seqeunceItems: [
                        {
                            type: 'returnStatement',
                            seqeunceItems: [
                                { type: 'return', value: null },
                                {
                                    type: 'product',
                                    seqeunceItems: [
                                        {
                                            type: 'product',
                                            seqeunceItems: [
                                                { type: 'number', value: 5 },
                                                { type: 'product', value: null },
                                                { type: 'number', value: 3 },
                                            ],
                                        },
                                        { type: 'product', value: null },
                                        { type: 'number', value: 4 },
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
        name: 'brackets product',
        source: 'return (3 * 4) * 5;',
        exitCode: 60,
        ast: {
            type: 'program',
            sequenceItems: [
                {
                    type: 'statement',
                    sequenceItems: [
                        {
                            type: 'returnStatement',
                            sequenceItems: [
                                { type: 'return', value: null },
                                {
                                    type: 'binaryExpression',
                                    sequenceItems: [
                                        {
                                            type: 'binaryExpression',
                                            sequenceItems: [
                                                { type: 'number', value: 3 },
                                                { type: 'product', value: null },
                                                { type: 'number', value: 4 },
                                            ],
                                        },
                                        { type: 'product', value: null },
                                        { type: 'number', value: 5 },
                                    ],
                                },
                            ],
                        },
                        { type: 'statementSeparator', value: null },
                        { type: undefined, value: undefined },
                    ],
                },
            ],
        },
    },
    {
        name: 'double function',
        source: 'doubleIt := a: Integer => 2 * a; return doubleIt(100);',
        exitCode: 200,
    },
    {
        name: 'subtraction',
        source: 'return 7 - 5;',
        exitCode: 2,
    },
    {
        name: 'order of operations',
        source: 'return 2 * 5 - 1;',
        exitCode: 9,
    },
    {
        name: 'associativity of subtraction',
        source: 'return 5 - 2 - 1;',
        exitCode: 2,
    },
    {
        name: 'ternary true',
        source: 'return 1 == 1 ? 5 : 6;',
        exitCode: 5,
    },
    {
        name: 'parse error',
        source: '=>',
        parseErrors: [
            {
                expected: 'identifier',
                found: 'fatArrow',
                sourceLocation: { column: 1, line: 1 },
            },
        ],
    },
    {
        name: 'ternary in function false',
        source: `
ternary := a: Boolean => a ? 9 : 5;
return ternary(false);`,
        exitCode: 5,
    },

    {
        name: 'ternary in function then subtract',
        source: `
ternaryFunc := a:Boolean => a ? 9 : 3;
return ternaryFunc(true) - ternaryFunc(false);`,
        exitCode: 6,
    },

    {
        name: 'equality comparison true',
        source: `
isFive := five: Integer => five == 5 ? 2 : 7;
return isFive(5);`,
        exitCode: 2,
    },

    {
        name: 'equality comparison false',
        source: `
isFive := notFive: Integer => notFive == 5 ? 2 : 7;
return isFive(11);`,
        exitCode: 7,
    },
    {
        name: '2 arg recursve',
        source: `
recursiveAdd := x: Integer, y: Integer => x == 0 ? y : recursiveAdd(x - 1, y + 1);
return recursiveAdd(4,11);`,
        exitCode: 15,
    },
    {
        name: 'uninferable recursive',
        source: `
recursive := x: Integer => recursive(x);
return recursive(1);`,
        exitCode: 15,
    },
    {
        name: 'return bool fail',
        source: 'return 1 == 2;',
        typeErrors: [
            {
                kind: 'wrongTypeReturn',
                expressionType: builtinTypes.Boolean,
                sourceLocation: { line: 1, column: 1 },
            },
        ],
    },

    {
        name: 'boolean literal false',
        source: `return false ? 1 : 2;`,
        exitCode: 2,
    },

    {
        name: 'boolean literal true',
        source: `return true ? 1 : 2;`,
        exitCode: 1,
    },
    {
        name: 'wrong type for arg',
        source: `
boolFunc := a: Boolean => 1;
return boolFunc(7);`,
        typeErrors: [
            {
                kind: 'wrongArgumentType',
                targetFunction: 'boolFunc',
                passedType: builtinTypes.Integer,
                expectedType: builtinTypes.Boolean,
                sourceLocation: { line: 3, column: 8 },
            },
        ],
    },
    {
        name: 'assign wrong type',
        source: 'myInt: Integer = false; return myInt;',
        typeErrors: [
            {
                kind: 'assignWrongType',
                lhsName: 'myInt',
                lhsType: builtinTypes.Integer,
                rhsType: builtinTypes.Boolean,
                sourceLocation: { line: 1, column: 1 },
            },
        ],
    },

    {
        name: 'assign function to typed var',
        source: 'myFunc: Function<Integer, Integer> = a: Integer => a; return myFunc(37);',
        exitCode: 37,
    },

    {
        name: 'assign function with multiple args to typed var',
        source: `
myFunc: Function<Integer, String, Integer> = (a: Integer, b: String) => a + length(b);
return myFunc(4, "four");`,
        exitCode: 8,
    },
    {
        name: 'string equality: inequal same length',
        source: `str1 := "a";
str2 := "b";
return str1 == str2 ? 1 : 2;
`,
        exitCode: 2,
    },
    {
        name: 'string equality: inequal different length',
        source: `str1 := "aa";
str2 := "a";
return str1 == str2 ? 7 : 2;
`,
        exitCode: 2,
    },
    {
        name: 'assign function with no args to typed var',
        source: `
myFunc: Function<Integer> = () => 111;
return myFunc();`,
        exitCode: 111,
    },

    {
        name: 'return local integer',
        source: 'myVar: Integer = 3 * 3; return myVar;',
        exitCode: 9,
    },
    {
        name: 'many temporaries, spill to ram',
        source: 'return 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1;',
        exitCode: 1,
        failingBackends: ['mips'],
    },

    {
        name: 'multi statement function with locals',
        source: `
quadrupleWithLocal := a: Integer => { b: Integer = 2 * a; return 2 * b; };
return quadrupleWithLocal(5);`,
        exitCode: 20,
    },

    {
        name: 'multi statement function with type error',
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
    },

    {
        name: 'multi statement function on multiple lines',
        source: `
quadrupleWithLocal := a: Integer => {
    b: Integer = 2 * a;
    return 2 * b;
};

return quadrupleWithLocal(5);`,
        exitCode: 20,
    },
    {
        name: 'string length with type inferred',
        source: `myStr := "test2"; return length(myStr);`,
        exitCode: 5,
    },
    {
        name: 'wrong type global',
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
    },
    {
        name: 'concatenate and get length then subtract',
        source: `return length("abc" ++ "defg") - 2;`,
        exitCode: 5,
    },
    {
        name: 'parsing fails for extra invalid tokens',
        source: `return 5; (`,
        parseErrors: [
            {
                found: 'leftBracket',
                expected: 'endOfFile',
                sourceLocation: { line: 1, column: 11 },
            },
        ],
    },
    {
        name: 'addition',
        source: `return length("foo") + 5;`,
        exitCode: 8,
    },
    {
        name: 'two args',
        source: `
myAdd := a: Integer, b: Integer => a + b;
return myAdd(7, 4);`,
        exitCode: 11,
    },
    {
        name: 'two args with expression argument',
        source: `
myAdd := a: Integer, b: Integer => a + b;
return myAdd(7 + 7, 4);`,
        exitCode: 18,
    },
    {
        name: 'three args',
        source: `
myAdd := a: Integer, b: Integer, c: Integer => a + b + c;
return myAdd(7, 4, 5);`,
        exitCode: 16,
    },
    {
        name: 'one bracketed arg',
        source: `
times11 := (a: Integer) => a * 11;
return times11(1);`,
        exitCode: 11,
    },
    {
        name: 'two bracketed args',
        source: `
timess := (a: Integer, b: Integer) => a * b;
return timess(11, 1);`,
        exitCode: 11,
    },
    {
        name: 'call with wrong number of args',
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
    },
    {
        name: 'call with wrong arg type',
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
    },

    {
        name: 'print string with space',
        source: `
dummy := print("sample string with space");
return 1;`,
        exitCode: 1,
        stdout: 'sample string with space',
    },

    {
        name: 'require/force no return value for print',
        source: `
print("sample string");
return 1;`,
        exitCode: 1,
        stdout: 'sample string',
    },

    {
        name: 'print string containing number',
        source: `
dummy := print("1");
return 1 + dummy - dummy;`,
        exitCode: 1,
        stdout: '1',
        // Fails mips because of the silly way we extract exit codes.
        failingBackends: ['mips'],
    },
    {
        name: 'assign result of call to builtin to local in function',
        source: `
lengthOfFoo := (dummy: Integer) => {
    dumme := length("foo");
    return dumme;
};
return lengthOfFoo(1);`,
        exitCode: 3,
    },
    {
        name: 'string args',
        source: `
excitmentifier := (boring: String) => {
    dummy := print(boring ++ "!");
    return 11 + dummy - dummy;
};
return excitmentifier("Hello World");`,
        stdout: 'Hello World!',
        exitCode: 11,
    },
    {
        name: 'reassign integer',
        source: `
a := 1;
bb := a + 5;
a = 2;
c := a + bb;
return c;`,
        exitCode: 8,
    },
    {
        name: 'reassign to undeclared identifier',
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
    },
    {
        name: 'reassigning wrong type',
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
    },
    {
        name: 'reassign to a using expression including a',
        source: `
hello := "HelloWorld";
hello = hello ++ "!";
return length(hello);`,
        exitCode: 11,
    },
    {
        name: 'reassigning wrong type inside function',
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
    },
    {
        name: 'variable named b',
        source: `
b := 2;
return b;`,
        exitCode: 2,
    },
    {
        name: 'Spill With Local Variables',
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
    },
    // TODO: rewrite this in a way that it is guaranteed to cause spilling
    {
        name: 'Spill With Local Variables and Local Struct',
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
    },

    {
        name: 'Spill with Local Variables and Local Struct in Function',
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
    },
];
