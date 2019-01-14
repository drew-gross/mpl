import { ExecutionResult } from './api.js';

export type TestCase = {
    name: string;
    source: string;
    exitCode: number;
    stdout?: string;
    stdin?: string;
    failing?: boolean;
};

export const passed = (testCase: TestCase, result: ExecutionResult) => {
    if ('error' in result) return false;
    if (testCase.exitCode != result.exitCode) return false;
    if ('stdout' in testCase && testCase.stdout != result.stdout) return false;
    return true;
};
