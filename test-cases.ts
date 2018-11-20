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
];

export default testCases;
