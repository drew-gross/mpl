import * as clone from 'clone';
import prettyParseError from './parser-lib/pretty-parse-error.js';
import * as omitDeep from 'omit-deep';
import { exec } from 'child-process-promise';
import { Backend, TypeError } from './api.js';
import { Ast } from './ast.js';
import { compile, parseErrorToString } from './frontend.js';
import { file as tmpFile } from 'tmp-promise';
import { writeFile, outputFile } from 'fs-extra';
import debug from './util/debug.js';
import join from './util/join.js';
import { tokenSpecs, grammar } from './grammar.js';
import { parse, stripResultIndexes, parseResultIsError, stripSourceLocation } from './parser-lib/parse.js';
import { makeTargetProgram } from './threeAddressCode/generator.js';
import { mallocWithSbrk, printWithPrintRuntimeFunction } from './threeAddressCode/runtime.js';
import { programToString } from './threeAddressCode/programToString.js';
import { parseProgram as parseTacProgram, parseFunction } from './threeAddressCode/parser.js';
import { backends } from './backend-utils.js';
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
        printSubsteps = [],
        debugSubsteps = [],
        failing = [],
        vizAst = false,
    }: TestOptions
) => {
    if (typeof printSubsteps === 'string') {
        printSubsteps = [printSubsteps];
    }
    if (typeof debugSubsteps === 'string') {
        debugSubsteps = [debugSubsteps];
    }
    if (typeof failing === 'string') {
        failing = [failing];
    }
    const printableSubsteps = ['js', 'tokens', 'ast', 'c', 'mips', 'x64', 'structure', 'threeAddressCode'];
    printSubsteps.forEach(substepToPrint => {
        if (!printableSubsteps.includes(substepToPrint)) {
            t.fail(`${substepToPrint} is not a printable substep`);
        }
    });

    // Make sure it parses
    const programInfo = produceProgramInfo(source);
    if (typeof programInfo == 'string') {
        t.fail(programInfo);
        return;
    }

    // Frontend
    if (expectedAst) {
        t.deepEqual(stripSourceLocation(programInfo.ast), expectedAst);
    }
    if (expectedParseErrors && 'parseErrors' in programInfo.frontendOutput) {
        // I'm still iterating on how these keys will work. No point fixing the tests yet.
        const keysToOmit = ['whileParsing', 'foundTokenText'];
        t.deepEqual(expectedParseErrors, omitDeep(programInfo.frontendOutput.parseErrors, keysToOmit));
        return;
    } else if ('parseErrors' in programInfo.frontendOutput) {
        t.fail(
            `Found parse errors when none expected: ${join(
                programInfo.frontendOutput.parseErrors.map(parseErrorToString),
                ', '
            )}`
        );
        return;
    } else if (expectedParseErrors) {
        t.fail('Expected parse errors and none found');
        return;
    }

    if (expectedTypeErrors && 'typeErrors' in programInfo.frontendOutput) {
        t.deepEqual(expectedTypeErrors, programInfo.frontendOutput.typeErrors);
        return;
    } else if ('typeErrors' in programInfo.frontendOutput) {
        t.fail(
            `Found type errors when none expected: ${join(
                programInfo.frontendOutput.typeErrors.map(typeErrorToString),
                ', '
            )}`
        );
        return;
    } else if (expectedTypeErrors) {
        t.fail('Expected type errors and none found');
        return;
    }

    // Run valdations on frontend output (currently just detects values that don't match their type)
    programInfo.frontendOutput.functions.forEach(f => {
        f.variables.forEach(v => {
            if (!v.type.kind) {
                t.fail(`Invalid frontend output: ${v.name} (in ${f.name}) had a bad type!`);
            }
        });
    });

    // Do a roundtrip on three address code to string and back to check the parser for that
    const tac = makeTargetProgram({
        backendInputs: programInfo.frontendOutput,
        targetInfo: {
            alignment: 17,
            bytesInWord: 13,
            cleanupCode: [],
            mallocImpl: mallocWithSbrk(7),
            printImpl: printWithPrintRuntimeFunction(11),
        },
    });

    const stringForm = programToString(tac);

    // always print string form while working on parser
    if (printSubsteps.includes('threeAddressCode')) {
        console.log(stringForm);
    }

    const roundtripResult = parseTacProgram(stringForm);
    if (Array.isArray(roundtripResult)) {
        t.fail(
            join(
                roundtripResult.map(e => {
                    if (typeof e === 'string') {
                        return e;
                    } else {
                        return (
                            prettyParseError(
                                stringForm,
                                e.sourceLocation,
                                `found ${e.found}, expected ${e.expected}`
                            ) || ''
                        );
                    }
                }),
                '\n\n'
            )
        );
    }

    // TODO: check the whole struct. Currently we don't check string literals because I haven't implemented that in the parser/generator
    t.deepEqual(tac.functions, (roundtripResult as any).functions);
    t.deepEqual(tac.globals, (roundtripResult as any).globals);
    // Backends
    for (let i = 0; i < backends.length; i++) {
        const backend = backends[i];
        if (!failing.includes(backend.name)) {
            const exeFile = await tmpFile({ postfix: `.${backend.name}` });
            const exeContents = backend.mplToExectuable(programInfo.frontendOutput);
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

            if (result.exitCode !== exitCode || result.stdout !== expectedStdOut) {
                const errorMessage = `${backend.name} had unexpected output.
Exit code: ${result.exitCode}. Expected: ${exitCode}.
Stdout: "${result.stdout}".
Expected: "${expectedStdOut}"`;
                t.fail(errorMessage);
            }
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
