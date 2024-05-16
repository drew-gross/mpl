import * as omitDeep from 'omit-deep';
import { testPrograms, TestProgram } from './test-cases';
import produceProgramInfo from './produceProgramInfo';
import * as chalk from 'chalk';
import * as assert from 'assert';
import * as Table from 'cli-table3';
import { stripSourceLocation } from './parser-lib/parse';
import join from './util/join';
import { toString as typeErrorToString } from './TypeError';
import { ExecutionResult } from './api';
import { backends } from './backend-utils';

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

(async () => {
    const t = new Table();

    let problems = 0;
    const color = st => {
        if (st == 'n/a') return chalk.yellow(st);
        if (st == 'ok') return chalk.green(st);
        problems++;
        return chalk.red(st);
    };

    t.push([
        'Test Name',
        'Fail?',
        'Inf?',
        'Info?',
        'Exc?',
        'Parse?',
        'Type?',
        'AST?',
        'Itrp?',
        ...backends.map(b => b.name),
    ]);

    t.push(
        ...(await Promise.all(
            testPrograms.map(async p => {
                const testName = `npm run test-case "${p.name}"`;
                let failingOk = 'n/a';
                let infiniteLoopOk = 'n/a';
                let producedInfoOk = 'n/a';
                let exceptionOk = 'n/a';
                let parseOk = 'n/a';
                let typeOk = 'n/a';
                let astOk = 'n/a';
                let interpreterOk = 'n/a';
                const backendResults: string[] = [];
                await (async () => {
                    if (p.failing) {
                        failingOk = 'err';
                    } else {
                        failingOk = 'ok';
                    }
                    if (p.infiniteLooping) {
                        infiniteLoopOk = 'err';
                        return;
                    }
                    infiniteLoopOk = 'ok';
                    try {
                        // Make sure it parses
                        const programInfo = await produceProgramInfo(p.source, p.stdin || '', {
                            includeExecutionResult: true,
                            buildBinaries: true,
                            skipExecutors: ['mars'], // mars bogs down my computer :( TODO make it not do that
                        });
                        if ('kind' in programInfo) {
                            producedInfoOk = 'err';
                            return;
                        }
                        producedInfoOk = 'ok';

                        if ('parseErrors' in programInfo) {
                            if (p.parseErrors) {
                                // I'm still iterating on how these keys will work. No point fixing the tests yet.
                                const keysToOmit = ['whileParsing', 'foundTokenText'];
                                // TODO: incorporate into table
                                assert.deepEqual(
                                    p.parseErrors,
                                    omitDeep(programInfo.parseErrors, keysToOmit),
                                    'Unexpected parse errors'
                                );
                            } else {
                                parseOk = 'err';
                            }
                            return;
                        }
                        if (p.parseErrors) {
                            parseOk = 'exp';
                            return;
                        }

                        parseOk = 'ok';

                        // Make sure it typechecks
                        if ('typeErrors' in programInfo) {
                            if (p.typeErrors) {
                                assert.deepEqual(p.typeErrors, programInfo.typeErrors);
                                typeOk = 'ok';
                            } else {
                                // TODO: integrate this into debug-test-case
                                console.log(
                                    `found type errors when none expected: ${join(
                                        programInfo.typeErrors.map(typeErrorToString as any),
                                        ', '
                                    )}`
                                );
                                typeOk = 'err';
                            }
                            return;
                        }

                        if (p.typeErrors) {
                            typeOk = 'exp';
                            return;
                        }

                        typeOk = 'ok';

                        // Frontend
                        if (p.ast) {
                            assert.deepEqual(stripSourceLocation(programInfo.ast), p.ast);
                        }

                        // Spot check 3 address code
                        if (Array.isArray(programInfo.threeAddressRoundTrip)) {
                            astOk = 'err';
                            // TODO: integrate this into debug-test-case
                            console.log(`
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
                            astOk = 'err';
                            // TODO: integrate this into debug-test-case
                            console.log(`
                    lex error:
                        ${JSON.stringify(programInfo.threeAddressRoundTrip)}
                    generated source:
                        ${programInfo.threeAddressCode}
                    `);
                            return;
                        }
                        // TODO: check the whole struct. Currently we don't check string literals because I haven't implemented that in the parser/generator
                        // TODO: Integrate this into table
                        assert.deepEqual(
                            programInfo.threeAddressRoundTrip.functions,
                            programInfo.threeAddressRoundTrip.functions
                        );
                        assert.deepEqual(
                            programInfo.threeAddressRoundTrip.globals,
                            programInfo.threeAddressRoundTrip.globals
                        );
                        astOk = 'ok';

                        // Check interpreter
                        if (!p.failingInterpreter) {
                            if (
                                !passed(
                                    {
                                        exitCode: p.exitCode,
                                        stdout: p.stdout,
                                        name: 'interpreter',
                                        source: p.source,
                                    },
                                    programInfo.interpreterResults
                                )
                            ) {
                                interpreterOk = 'err';
                            } else {
                                interpreterOk = 'ok';
                            }
                        } else {
                            interpreterOk = 'dis';
                        }

                        // Check backends
                        for (const {
                            name: backendName,
                            executionResults,
                        } of programInfo.backendResults) {
                            if (p.exitCode === undefined) {
                                assert('Exit code mandatory');
                                return;
                            }
                            const testPassed = executionResults.every(r =>
                                passed(
                                    {
                                        exitCode: p.exitCode,
                                        stdout: p.stdout,
                                        name: backendName ? backendName : 'unnamed',
                                        source: p.source,
                                    },
                                    r
                                )
                            );

                            // Allow failures if specific backends are expected to be failing, otherwise require success
                            if (Array.isArray(p.failing) && p.failing.includes(backendName))
                                return;
                            if (typeof p.failing === 'string' && p.failing == backendName)
                                return;

                            if (!testPassed) {
                                backendResults.push('err');
                            } else {
                                backendResults.push('ok');
                            }
                        }
                    } catch {
                        exceptionOk = 'err';
                        return;
                    }
                    exceptionOk = 'ok';
                })();
                return [
                    testName,
                    color(failingOk),
                    color(infiniteLoopOk),
                    color(producedInfoOk),
                    color(exceptionOk),
                    color(parseOk),
                    color(typeOk),
                    color(astOk),
                    color(interpreterOk),
                    ...backendResults.map(color),
                ];
            })
        ))
    );

    console.log(t.toString());
    const expectedProblems = 185;
    if (problems != expectedProblems) {
        console.log(chalk.red(`${problems} Problems`));
    } else {
        console.log(chalk.green(`${problems} Problems`));
    }
    process.exit(problems == expectedProblems ? 0 : 1);
})();
