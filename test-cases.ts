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
        name: 'String Concatenation',
        source: `
str1: String = "a";
str2: String = "b";
return str1 ++ str2 == "ab" ? 5 : 10;
`,
        exitCode: 5,
    },
];

export default testCases;
