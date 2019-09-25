import { ExecutionResult } from './api.js';

export type TestCase = {
    // Test name
    name: string;

    // Test source code
    source: string;

    // Expected results of test
    exitCode?: number;
    stdout?: string;
    parseErrors?: any[];
    ast?: any;

    // Runtime inputs to test
    stdin?: string;

    // Control test runner
    failing?: boolean;
    only?: boolean;
};

export const passed = (testCase: TestCase, result: ExecutionResult) => {
    if ('error' in result) return false;
    if (testCase.exitCode != result.exitCode) return false;
    if ('stdout' in testCase && testCase.stdout !== undefined && testCase.stdout != result.stdout) return false;
    return true;
};
