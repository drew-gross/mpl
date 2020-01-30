import { ExecutionResult } from './api';

export type TestCase = {
    // Test name
    name: string;

    // Test source code
    source: string;

    // Expected results of test
    exitCode?: number;
    stdout?: string;
    parseErrors?: any[];
    typeErrors?: any[];
    ast?: any;

    // Runtime inputs to test
    stdin?: string;

    // Control test runner
    failing?: boolean; // Expect this to fail
    only?: boolean; // Run only this test
    infiniteLooping?: boolean; // Don't even attempt to compile this, it will infinite loop
};

export const passed = (testCase: TestCase, result: ExecutionResult) => {
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
