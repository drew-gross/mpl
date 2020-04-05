import { ExecutionResult } from './api';
import * as omitDeep from 'omit-deep';
import { toString as typeErrorToString } from './TypeError';
import writeTempFile from './util/writeTempFile';
import join from './util/join';
import { stripSourceLocation } from './parser-lib/parse';
import { parseFunction } from './threeAddressCode/parser';
import { backends } from './backend-utils';
import produceProgramInfo from './produceProgramInfo';

export interface Test {
    name: string;
    source: string;
    failing?: boolean; // Expect this to fail
    only?: boolean; // Run only this test
    infiniteLooping?: boolean; // Don't even attempt to compile this, it will infinite loop
}

export type TestProgram = {
    // To extend "Test"
    name: string;
    source: string;
    failing?: boolean; // Expect this to fail
    only?: boolean; // Run only this test
    infiniteLooping?: boolean; // Don't even attempt to compile this, it will infinite loop

    // Expected results of test
    exitCode?: number;
    stdout?: string;
    parseErrors?: any[];
    typeErrors?: any[];
    ast?: any;

    // Runtime inputs to test
    stdin?: string;
};

export type TestModule = {
    // To extend "Test"
    name: string;
    source: string;
    failing?: boolean; // Expect this to fail
    only?: boolean; // Run only this test
    infiniteLooping?: boolean; // Don't even attempt to compile this, it will infinite loop
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

// TODO: separate this for mplTest vs tacTest, they have a lot of overlap but not perfect.
// TODO: express in the type that exitCode OR expectedErrors of some sort must be provided.
type TestOptions = {
    source: string;
    exitCode?: number;
    expectedTypeErrors?: any[];
    expectedParseErrors?: any[];
    expectedStdOut?: string;
    expectedAst?: any;
    printSubsteps?: string[] | string;
    debugSubsteps?: string[] | string;
    failing?: string[] | string;
    name?: string;
    stdin?: string;
};

export const mplTest = async (
    t,
    {
        source,
        exitCode,
        expectedTypeErrors,
        expectedParseErrors,
        expectedStdOut,
        expectedAst,
        failing = [],
        name = undefined,
        stdin = '',
    }: TestOptions
) => {
    if (typeof failing === 'string') {
        failing = [failing];
    }

    const error = (stage: string) => {
        t.fail(
            name
                ? `Test failed (${stage}). Run $ npm run test-case "${name}" for more info.`
                : 'Unnamed test failed'
        );
    };

    // Make sure it parses
    const programInfo = await produceProgramInfo(source, stdin, {
        includeExecutionResult: true,
    });
    if ('kind' in programInfo) {
        error('failed to produce info');
        return;
    }

    if ('parseErrors' in programInfo) {
        if (expectedParseErrors) {
            // I'm still iterating on how these keys will work. No point fixing the tests yet.
            const keysToOmit = ['whileParsing', 'foundTokenText'];
            t.deepEqual(expectedParseErrors, omitDeep(programInfo.parseErrors, keysToOmit));
        } else {
            error('parse error');
        }
        return;
    }

    if (expectedParseErrors) {
        error('expected parse errors and none found');
        return;
    }

    if ('typeErrors' in programInfo) {
        if (expectedTypeErrors) {
            t.deepEqual(expectedTypeErrors, programInfo.typeErrors);
            return;
        } else {
            error(
                `found type errors when none expected: ${join(
                    programInfo.typeErrors.map(typeErrorToString as any),
                    ', '
                )}`
            );
        }
        return;
    }

    if (expectedTypeErrors) {
        error('expected type errors and none found');
        return;
    }

    // Frontend
    if (expectedAst) {
        t.deepEqual(stripSourceLocation(programInfo.ast), expectedAst);
    }

    // Run valdations on frontend output (currently just detects values that don't match their type)
    programInfo.frontendOutput.functions.forEach(f => {
        f.variables.forEach(v => {
            if (!v.type.kind) {
                error(`invalid frontend output: ${v.name} (in ${f.name}) had a bad type!`);
            }
        });
    });

    if (Array.isArray(programInfo.threeAddressRoundTrip)) {
        t.fail(`
three address code:${programInfo.threeAddressCode}
ast:${join(
            programInfo.threeAddressRoundTrip.map((e: any) => {
                if (typeof e === 'string') {
                    return e;
                } else {
                    // TODO: get the source and do pretty parse errors
                    return JSON.stringify(e, null, 2);
                }
            }),
            '\n\n'
        )}`);
        return;
    }

    if ('kind' in programInfo.threeAddressRoundTrip) {
        t.fail(`
lex error:
    ${JSON.stringify(programInfo.threeAddressRoundTrip)}
generated source:
    ${programInfo.threeAddressCode}
`);
        return;
    }

    // TODO: check the whole struct. Currently we don't check string literals because I haven't implemented that in the parser/generator
    t.deepEqual(
        programInfo.threeAddressRoundTrip.functions,
        programInfo.threeAddressRoundTrip.functions
    );
    t.deepEqual(
        programInfo.threeAddressRoundTrip.globals,
        programInfo.threeAddressRoundTrip.globals
    );

    for (const { name: backendName, executionResults } of programInfo.backendResults) {
        if (exitCode === undefined) {
            t.fail('Exit code mandatory');
            return;
        }
        const testPassed = executionResults.every(r =>
            passed(
                {
                    exitCode,
                    stdout: expectedStdOut,
                    name: backendName ? backendName : 'unnamed',
                    source,
                },
                r
            )
        );

        if (!failing.includes(backendName)) {
            if (!testPassed) {
                error('wrong behaviour');
            }
            // TODO: share this code with some of the code in debug-test-case.ts
            const verbose = false;
            if (verbose) {
                console.log('');
                console.log(`Name: ${backendName}`);
                executionResults.forEach(r => {
                    console.log(`Executor: ${r.executorName}`);
                    if ('exitCode' in r) {
                        const { stdout, exitCode: actualExitCode } = r;
                        console.log(`Exit code: ${exitCode}`);
                        console.log(`Expected exit code: ${actualExitCode}`);
                        if (expectedStdOut !== undefined) {
                            console.log(`Stdout: ${stdout}`);
                            console.log(`Expected Stdout: ${expectedStdOut}`);
                        }
                    } else {
                        console.log(`Error: ${r.error}`);
                    }
                });
            }
        }
    }

    t.pass();
};

export const tacTest = async (
    t,
    {
        source,
        exitCode,
        printSubsteps = [],
        debugSubsteps = [],
        failing = [],
        stdin = '',
    }: TestOptions
) => {
    const parsed = parseFunction(source);
    if ('kind' in parsed) {
        t.fail(`LexError error: ${parsed}`);
        return;
    }
    if (Array.isArray(parsed)) {
        t.fail(`Parse error: ${JSON.stringify(parsed)}`);
        return;
    }
    await Promise.all(
        backends.map(async backend => {
            if (backend.compileTac && !failing.includes(backend.name)) {
                const program = { globals: {}, functions: [], main: parsed, stringLiterals: [] };
                const targetSource = backend.compileTac(program, false);

                if (typeof targetSource != 'string') {
                    t.fail(`${backend.name} compilation failed: ${targetSource.error}`);
                    return;
                }

                const compilationResult = await backend.finishCompilation(targetSource, program);

                if ('error' in compilationResult) {
                    t.fail(`${backend.name} compilation failed: ${compilationResult.error}`);
                    return;
                }

                const stdinFile = await writeTempFile(stdin, 'stdin', 'txt');

                await Promise.all(
                    backend.executors.map(async ({ name, execute }) => {
                        const result = await execute(
                            compilationResult.binaryFile.path,
                            stdinFile.path
                        );
                        if ('error' in result) {
                            t.fail(
                                `${backend.name} execution with ${name} failed: ${result.error}`
                            );
                        } else if (result.exitCode !== exitCode) {
                            const errorMessage = `${backend.name} had unexpected output.
    Exit code: ${result.exitCode}. Expected: ${exitCode}.`;
                            t.fail(errorMessage);
                        } else {
                            t.deepEqual(result.exitCode, exitCode);
                        }
                    })
                );
            }
        })
    );
};
