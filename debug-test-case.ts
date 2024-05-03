import { file as tmpFile } from 'tmp-promise';
import { testPrograms, testModules } from './test-cases';
import { passed } from './test-case';
import produceProgramInfo from './produceProgramInfo';
import writeSvg from './util/graph/writeSvg';
import writeTempFile from './util/writeTempFile';
import { prompt } from 'inquirer';
import * as dot from 'graphlib-dot';
import { toDotFile } from './parser-lib/parse';
import { toString as typeErrorToString } from './TypeError';
import * as chalk from 'chalk';
import * as commander from 'commander';
import annotateSource from './annotateSource';
import * as deepEqual from 'deep-equal';
import renderParseError from './parser-lib/renderParseError';
import { mplLoader } from './mpl-loader';

(async () => {
    // Commander is dumb
    let args = process.argv;
    const buildBinaries = !args.includes('--no-build-binaries');
    args = args.filter(arg => arg != '--no-build-binaries');
    commander
        .arguments('<test_name>')
        .allowUnknownOption()
        .option('--no-execute', "Only produce binaries, don't execute them")
        .option(
            '--skip-backends [backends]',
            "Don't run [backend]",
            (val, memo) => {
                (memo as any).push(val);
                return memo;
            },
            []
        )
        .parse(args);
    const testCase = testPrograms.find(c => c.name == commander.args[0]);

    if (!testCase) {
        const testModule = testModules.find(c => c.name == commander.args[0]);
        if (!testModule) {
            console.log(`Could not find a test case named "${commander.args[0]}"`);
            return;
        }
        // TODO: Refactor to produceModuleInfo?
        const errors: any[] = [];
        const jsSource = mplLoader(testModule.source, {
            emitError: e => {
                debugger;
                errors.push(e);
            },
        });
        if (errors.length != 0) {
            console.log(`Errors in module:`);
            errors.forEach(e => {
                console.log(e.stack);
            });
            return;
        }
        console.log(jsSource);
        return;
    }

    const programInfo = await produceProgramInfo(
        testCase.source,
        testCase.stdin ? testCase.stdin : '',
        {
            includeExecutionResult: commander.execute,
            buildBinaries,
            skipBackends: commander.skipBackends,
        }
    );

    // TODO: Unify and improve error printing logic with test-utils and produceProgramInfo
    if ('kind' in programInfo) {
        console.log('Failed to lex');
        return;
    }

    if ('parseErrors' in programInfo) {
        console.log(`Failed to parse:`);
        let errorString: string = '';
        programInfo.parseErrors.forEach(e => {
            errorString += renderParseError(e, testCase.source);
        });
        console.log(errorString);
        return;
    }

    if ('typeErrors' in programInfo) {
        let errorString: string = '';
        programInfo.typeErrors.forEach(e => {
            errorString += annotateSource(
                testCase.source,
                (e as any).sourceLocation,
                typeErrorToString(e as any)
            );
        });
        console.log(errorString);
        return;
    }

    console.log(`Mpl: ${(await writeTempFile(testCase.source, 'mpl', 'mpl')).path}`);
    console.log(
        `Tokens: ${(await writeTempFile(JSON.stringify(programInfo.tokens, null, 2), 'tokens', 'json'))
            .path
        }`
    );
    const astFile = await writeTempFile(JSON.stringify(programInfo.ast, null, 2), 'ast', 'json');
    const astInfo = `Ast: ${astFile.path}`;
    const astMismatch = 'ast' in testCase && !deepEqual(testCase.ast, programInfo.ast);
    if (astMismatch) {
        console.log(chalk.red(astInfo));
    } else {
        console.log(astInfo);
    }

    const dotText = dot.write(toDotFile(programInfo.ast));
    const svgFile = await tmpFile({ template: 'ast-XXXXXX.svg', dir: '/tmp' });
    await writeSvg(dotText, svgFile.path);
    console.log(`Ast SVG: ${svgFile.path}`);

    console.log(
        `Structure: ${(await writeTempFile(programInfo.structure, 'structure', 'txt')).path}`
    );

    console.log(
        `Three Address Code: ${(await writeTempFile(programInfo.threeAddressCode, 'three-address-code', 'txt')).path
        }`
    );
    const roundTripParsedPath = (
        await writeTempFile(
            JSON.stringify(programInfo.threeAddressRoundTrip, null, 2),
            'round-trip-parsed',
            'txt'
        )
    ).path;
    const roundTripSuccess =
        !Array.isArray(programInfo.threeAddressRoundTrip) &&
        !('kind' in programInfo.threeAddressRoundTrip);
    if (roundTripSuccess) {
        console.log(`Three Address Code Round Trip Parse: ${roundTripParsedPath}`);
    } else {
        console.log(chalk.red(`Three Address Code Round Trip Parse: ${roundTripParsedPath}`));
    }

    console.log('\nBackends:');
    programInfo.backendResults.forEach(({ name, compilationResult, executionResults }) => {
        const testPassed = executionResults.every(r => passed(testCase, r));

        if (testPassed) {
            console.log(`    ${name}:`);
        } else {
            console.log(chalk.red(`    ${name}:`));
        }

        if ('error' in compilationResult) {
            console.log(chalk.red(`        Compilation Failed: ${compilationResult.error}`));
            if ('intermediateFile' in compilationResult) {
                console.log(
                    chalk.red(
                        `        Intermediate File: ${compilationResult.intermediateFile.path}`
                    )
                );
            }
        } else {
            console.log(`        Source: ${compilationResult.sourceFile.path}`);
            console.log(`        Binary: ${compilationResult.binaryFile.path}`);
            if (compilationResult.threeAddressCodeFile) {
                console.log(
                    `        Three Address Code: ${compilationResult.threeAddressCodeFile.path}`
                );
            }

            executionResults.forEach(r => {
                console.log(`        Executor: ${r.executorName}`);
                if ('error' in r) {
                    // TODO: put debug instructions too
                    console.log(chalk.red(`            Execution Failed: ${r.error}`));
                } else {
                    let log =
                        testCase.exitCode == r.exitCode
                            ? s => console.log(s)
                            : s => console.log(chalk.red(s));
                    log(`            Expected Exit Code: ${testCase.exitCode}`);
                    log(`            Actual Exit Code: ${r.exitCode}`);

                    if (testCase.stdout) {
                        log =
                            testCase.stdout == r.stdout
                                ? s => console.log(s)
                                : s => console.log(chalk.red(s));
                        log(`            Expected stdout: ${testCase.stdout}`);
                        log(`            Actual stdout: ${r.stdout}`);
                    }
                    console.log(`            Run: ${r.runInstructions}`);
                    console.log(`            Debug: ${r.debugInstructions}`);
                    console.log('');
                }
            });
        }
    });
    console.log('Interpreter:');
    let log =
        'error' in programInfo.interpreterResults ||
            testCase.exitCode == programInfo.interpreterResults.exitCode
            ? s => console.log(s)
            : s => console.log(chalk.red(s));
    if ('error' in programInfo.interpreterResults) {
        log(`    Error: ${programInfo.interpreterResults.error}`);
    } else {
        log(`    Expected Exit Code: ${testCase.exitCode}`);
        log(`    Actual Exit Code: ${programInfo.interpreterResults.exitCode}`);
    }
    await prompt({
        type: 'confirm',
        message:
            'Holding temporary files. Press Enter when you are done to exit. Temporary files may be removed.',
        name: 'unused',
    });
})();
