import TestCase from './test-case.js';

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
];

export default testCases;
