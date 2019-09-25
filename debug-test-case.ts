import { file as tmpFile } from 'tmp-promise';
import testCases from './test-cases.js';
import { passed } from './test-case.js';
import produceProgramInfo from './produceProgramInfo.js';
import writeSvg from './util/graph/writeSvg.js';
import writeTempFile from './util/writeTempFile.js';
import { prompt } from 'inquirer';
import * as dot from 'graphlib-dot';
import { toDotFile } from './parser-lib/parse.js';
import parseErrorToString from './parser-lib/parseErrorToString.js';
import { toString as typeErrorToString } from './TypeError.js';
import chalk from 'chalk';
import * as commander from 'commander';
import annotateSource from './annotateSource.js';

(async () => {
    commander
        .arguments('<test_name>')
        .option('--no-execute', "Only produce binaries, don't execute them")
        .option(
            '--skip-backends [backends]',
            "Don't run x64",
            (val, memo) => {
                memo.push(val);
                return memo;
            },
            []
        )
        .parse(process.argv);

    const testCase = testCases.find(c => c.name == commander.args[0]);

    if (!testCase) {
        console.log(`Could not find a test case named "${commander.args[0]}"`);
        return;
    }

    const programInfo = await produceProgramInfo(testCase.source, testCase.stdin ? testCase.stdin : '', {
        includeExecutionResult: commander.execute,
        skipBackends: commander.skipBackends,
    });

    // TODO: Unify and improve error printing logic with test-utils and produceProgramInfo
    if ('kind' in programInfo) {
        console.log('Failed to lex');
        return;
    }

    if ('parseErrors' in programInfo) {
        console.log(`Failed to parse:`);
        let errorString: string = '';
        programInfo.parseErrors.forEach(e => {
            // The semicolor the user forgot probably should go one space after where
            // the error is.
            const adjustedSourceLocation = e.sourceLocation;
            adjustedSourceLocation.column += 1;
            errorString += annotateSource(testCase.source, adjustedSourceLocation, parseErrorToString(e));
        });
        console.log(errorString);
        return;
    }

    if ('typeErrors' in programInfo) {
        let errorString: string = '';
        programInfo.typeErrors.forEach(e => {
            errorString += annotateSource(testCase.source, (e as any).sourceLocation, typeErrorToString(e as any));
        });
        console.log(errorString);
        return;
    }

    console.log(`Mpl: ${(await writeTempFile(testCase.source, '.mpl')).path}`);
    console.log(`Tokens: ${(await writeTempFile(JSON.stringify(programInfo.tokens, null, 2), '.json')).path}`);
    console.log(`Ast: ${(await writeTempFile(JSON.stringify(programInfo.ast, null, 2), '.json')).path}`);

    const dotText = dot.write(toDotFile(programInfo.ast));
    const svgFile = await tmpFile({ postfix: '.svg' });
    await writeSvg(dotText, svgFile.path);
    console.log(`Ast SVG: ${svgFile.path}`);

    console.log(`Structure: ${(await writeTempFile(programInfo.structure, '.txt')).path}`);

    console.log(`Three Address Code: ${(await writeTempFile(programInfo.threeAddressCode, '.txt')).path}`);
    const roundTripParsedPath = (await writeTempFile(
        JSON.stringify(programInfo.threeAddressRoundTrip, null, 2),
        '.txt'
    )).path;
    const roundTripSuccess =
        !Array.isArray(programInfo.threeAddressRoundTrip) && !('kind' in programInfo.threeAddressRoundTrip);
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
                console.log(chalk.red(`        Intermediate File:: ${compilationResult.intermediateFile.path}`));
            }
        } else {
            console.log(`        Source: ${compilationResult.sourceFile.path}`);
            console.log(`        Binary: ${compilationResult.binaryFile.path}`);
            if (compilationResult.threeAddressCodeFile) {
                console.log(`        Three Address Code: ${compilationResult.threeAddressCodeFile.path}`);
            }

            executionResults.forEach(r => {
                console.log(`        Executor: ${r.executorName}`);
                if ('error' in r) {
                    console.log(chalk.red(`            Execution Failed: ${r.error}`));
                } else {
                    let log = testCase.exitCode == r.exitCode ? s => console.log(s) : s => console.log(chalk.red(s));
                    log(`            Expected Exit Code: ${testCase.exitCode}`);
                    log(`            Actual Exit Code: ${r.exitCode}`);

                    if (testCase.stdout) {
                        log = testCase.stdout == r.stdout ? s => console.log(s) : s => console.log(chalk.red(s));
                        log(`            Expected stdout: ${testCase.stdout}`);
                        log(`            Actual stdout: ${r.stdout}`);
                    }
                    console.log(`            Debug: ${r.debugInstructions}`);
                    console.log('');
                }
            });
        }
    });

    await prompt({
        type: 'confirm',
        message: 'Holding temporary files. Press Enter when you are done to exit. Temporary files may be removed.',
        name: 'unused',
    });
})();
