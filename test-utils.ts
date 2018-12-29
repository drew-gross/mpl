import * as clone from 'clone';
import prettyParseError from './parser-lib/pretty-parse-error.js';
import * as omitDeep from 'omit-deep';
import { exec } from 'child-process-promise';
import { Backend, TypeError } from './api.js';
import { Ast } from './ast.js';
import { compile, parseErrorToString } from './frontend.js';
import { file as tmpFile } from 'tmp-promise';
import { writeFile } from 'fs-extra';
import debug from './util/debug.js';
import join from './util/join.js';
import { tokenSpecs, grammar } from './grammar.js';
import { parse, stripResultIndexes, parseResultIsError, stripSourceLocation } from './parser-lib/parse.js';
import { parseFunction } from './threeAddressCode/parser.js';
import { backends } from './backend-utils.js';
import { passed } from './test-case.js';
import produceProgramInfo from './produceProgramInfo.js';

// TODO: separate this for mplTest vs tacTest, they have a lot of overlap but not perfect.
type TestOptions = {
    source: string;
    exitCode: number;
    expectedTypeErrors: [any];
    expectedParseErrors: [any];
    expectedStdOut: string;
    expectedAst: [any];
    printSubsteps?: string[] | string;
    debugSubsteps?: string[] | string;
    failing?: string[] | string;
    vizAst: boolean;
    spills?: number;
    name?: string;
};

const typeErrorToString = (e: TypeError): string => JSON.stringify(e, null, 2);

export const mplTest = async (
    t,
    {
        source,
        exitCode,
        expectedTypeErrors,
        expectedParseErrors,
        expectedStdOut = '',
        expectedAst,
        failing = [],
        vizAst = false,
        name = undefined,
    }: TestOptions
) => {
    if (typeof failing === 'string') {
        failing = [failing];
    }
    // Make sure it parses
    const programInfo = await produceProgramInfo(source);
    if ('kind' in programInfo) {
        t.fail(`Lex Error: ${programInfo.error}`);
        return;
    }

    if ('parseErrors' in programInfo) {
        if (expectedParseErrors) {
            // I'm still iterating on how these keys will work. No point fixing the tests yet.
            const keysToOmit = ['whileParsing', 'foundTokenText'];
            t.deepEqual(expectedParseErrors, omitDeep(programInfo.parseErrors, keysToOmit));
        } else {
            t.fail(
                `Found parse errors when none expected: ${join(programInfo.parseErrors.map(parseErrorToString), ', ')}`
            );
        }
        return;
    }

    if (expectedParseErrors) {
        t.fail('Expected parse errors and none found');
        return;
    }

    if ('typeErrors' in programInfo) {
        if (expectedTypeErrors) {
            t.deepEqual(expectedTypeErrors, programInfo.typeErrors);
            return;
        } else {
            t.fail(
                `Found type errors when none expected: ${join(
                    programInfo.typeErrors.map(typeErrorToString as any),
                    ', '
                )}`
            );
        }
        return;
    }

    if (expectedTypeErrors) {
        t.fail('Expected type errors and none found');
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
                t.fail(`Invalid frontend output: ${v.name} (in ${f.name}) had a bad type!`);
            }
        });
    });

    if (Array.isArray(programInfo.threeAddressCode.roundTripParsed)) {
        t.fail(
            join(
                programInfo.threeAddressCode.roundTripParsed.map((e: any) => {
                    if (typeof e === 'string') {
                        return e;
                    } else {
                        return (
                            prettyParseError(
                                programInfo.threeAddressCode.asString,
                                e.sourceLocation,
                                `found ${e.found}, expected ${e.expected}`
                            ) || ''
                        );
                    }
                }),
                '\n\n'
            )
        );
        return;
    }

    if ('kind' in programInfo.threeAddressCode.roundTripParsed) {
        t.fail('lex error');
        return;
    }

    // TODO: check the whole struct. Currently we don't check string literals because I haven't implemented that in the parser/generator
    t.deepEqual(programInfo.threeAddressCode.roundTripParsed.functions, programInfo.threeAddressCode.parsed.functions);
    t.deepEqual(programInfo.threeAddressCode.roundTripParsed.globals, programInfo.threeAddressCode.parsed.globals);

    const testCaseName = name;
    for (let i = 0; i < programInfo.backendResults.length; i++) {
        const { name, executionResult } = programInfo.backendResults[i];
        if (!failing.includes(name)) {
            t.true(
                passed(
                    { exitCode, stdout: expectedStdOut, name: testCaseName ? testCaseName : 'unnamed', source: source },
                    executionResult
                ),
                testCaseName
                    ? `Test failed. Run $ npm run debug-test-case "${testCaseName}" for more info.`
                    : 'Unnamed test failed'
            );
        }
    }

    t.pass();
};

export const tacTest = async (
    t,
    { source, exitCode, printSubsteps = [], debugSubsteps = [], spills, failing = [] }: TestOptions
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
    if (spills) {
        t.deepEqual(parsed.spills, spills);
    }
    await Promise.all(
        backends.map(async backend => {
            if (backend.tacToExecutable && !failing.includes(backend.name)) {
                const exeFile = await tmpFile({ postfix: `.${backend.name}` });
                const newSource = clone(parsed);

                // TODO: This is pure jank. Should move responsibility for adding cleanup code to some place that makes actual sense.
                newSource.instructions.push(...backend.tacToExecutable.targetInfo.cleanupCode);

                const exeContents = backend.tacToExecutable.compile({
                    globals: {},
                    functions: [],
                    main: newSource.instructions,
                    stringLiterals: [],
                });

                if (printSubsteps.includes(backend.name)) {
                    console.log(exeContents);
                }

                await writeFile(exeFile.fd, exeContents);

                if (debugSubsteps.includes(backend.name)) {
                    if (backend.debug) {
                        await backend.debug(exeFile.path);
                    } else {
                        t.fail(`${backend.name} doesn't define a debugger`);
                    }
                }

                const result = await backend.execute(exeFile.path);
                if ('error' in result) {
                    t.fail(`${backend.name} execution failed: ${result.error}`);
                    return;
                }

                if (result.exitCode !== exitCode) {
                    const errorMessage = `${backend.name} had unexpected output.
    Exit code: ${result.exitCode}. Expected: ${exitCode}.`;
                    t.fail(errorMessage);
                } else {
                    t.deepEqual(result.exitCode, exitCode);
                }
            }
        })
    );
};
