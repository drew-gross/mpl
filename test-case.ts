import writeTempFile from './util/writeTempFile';
import { parseFunction } from './threeAddressCode/Function';
import { backends } from './backend-utils';
import { mplLoader } from './mpl-loader';

export interface Test {
    name: string;
    source: string;
    failing?: boolean | string | string[]; // Expect this to fail, or backends that are expected to fail
    only?: boolean; // Run only this test
    infiniteLooping?: boolean; // Don't even attempt to compile this, it will infinite loop
}

export type TestModule = {
    // To extend "Test"
    name: string;
    source: string;
    failing?: boolean | string | string[]; // Expect this to fail
    only?: boolean; // Run only this test
    infiniteLooping?: boolean; // Don't even attempt to compile this, it will infinite loop

    // To check results
    resultJs: string;
};

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

export const moduleTest = async (t, m: TestModule) => {
    const errors: Error[] = [];
    const resultJs = await mplLoader(m.source, { emitError: e => errors.push(e) });
    errors.forEach(e => {
        t.fail(e.stack);
    });
    t.deepEqual(m.resultJs, resultJs);
};

export const tacTest = async (
    t,
    {
        source,
        exitCode,
        // @ts-ignore
        printSubsteps = [],
        // @ts-ignore
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
                const program = { globals: {}, functions: new Map, main: parsed.f, stringLiterals: [] };
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
                        // mars bogs down my computer when running all tests. TODO: try to make it work.
                        if (name == 'mars') {
                            return;
                        }
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
