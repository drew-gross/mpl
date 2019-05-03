import { TestCase } from './test-case.js';

const testCases: TestCase[] = [
    {
        name: 'Bare Return',
        source: 'return 7',
        exitCode: 7,
    },
    {
        name: 'Single Product',
        source: 'return 2 * 2',
        exitCode: 4,
    },
    {
        name: 'Brackets',
        source: 'return (3)',
        exitCode: 3,
    },
    {
        name: 'Unused Function',
        source: 'constThree := a: Integer => 3; return 10',
        exitCode: 10,
    },
    {
        name: 'Used Function',
        source: 'takeItToEleven := a: Integer => 11; return takeItToEleven(0)',
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
return isFive(5) ? 1 : 0`,
        exitCode: 1,
    },
    {
        name: 'Ternary False',
        source: 'return 0 == 1 ? 5 : 6',
        exitCode: 6,
    },
    {
        name: 'String Copy',
        source: `myStr1: String = "testing"; myStr2: String = myStr1; return length(myStr2);`,
        exitCode: 7,
    },
    {
        name: 'Print',
        // TODO: print() maybe shouldn't return anything? Or return on error?
        source: `
    dummy := print("sample_string");
    return 1;`,
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
        parseErrors: [{ expected: 'statementSeparator', found: 'return', sourceLocation: { line: 4, column: 13 } }],
    },
    {
        name: 'Spill Self-Assigning Multiply',
        source: `
        // TODO: read enough stuff to cause a spill. then a = a * a. Or make this
        // a direct test of spill().
        `,
        exitCode: 9001,
        failing: true,
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
];

export default testCases;
