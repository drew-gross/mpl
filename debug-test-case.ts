import { file as tmpFile } from 'tmp-promise';
import { writeFile } from 'fs-extra';
import testCases from './test-cases.js';
import { passed } from './test-case.js';
import produceProgramInfo from './produceProgramInfo.js';
import writeSvg from './util/graph/writeSvg.js';
import writeTempFile from './util/writeTempFile.js';
import { prompt } from 'inquirer';
import * as dot from 'graphlib-dot';
import { toDotFile } from './parser-lib/parse.js';
import { programToString } from './threeAddressCode/programToString.js';
import chalk from 'chalk';

(async () => {
    if (process.argv.length != 3) {
        console.log('Exactly one test case must be named');
        return;
    }

    const testName = process.argv[2];

    const testCase = testCases.find(c => c.name == testName);

    if (!testCase) {
        console.log(`Could not find a test case named "${testName}"`);
        return;
    }

    const programInfo = await produceProgramInfo(testCase.source);

    if ('kind' in programInfo || 'parseErrors' in programInfo || 'typeErrors' in programInfo) {
        // TODO: Unify and improve error printing logic with test-utils and produceProgramInfo
        console.log(`Error in program: ${JSON.stringify(programInfo)}`);
        return;
    }

    console.log(`Tokens: ${(await writeTempFile(JSON.stringify(programInfo.tokens, null, 2), '.json')).path}`);
    console.log(`Ast: ${(await writeTempFile(JSON.stringify(programInfo.ast, null, 2), '.json')).path}`);

    const dotText = dot.write(toDotFile(programInfo.ast));
    const svgFile = await tmpFile({ postfix: '.svg' });
    await writeSvg(dotText, svgFile.path);
    console.log(`Ast SVG: ${svgFile.path}`);

    console.log(`Structure: ${(await writeTempFile(programInfo.structure, '.txt')).path}`);

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
    for (let i = 0; i < programInfo.backendResults.length; i++) {
        const { name, compilationResult, executionResult } = programInfo.backendResults[i];
        const testPassed = passed(testCase, executionResult);

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
        } else if ('error' in executionResult) {
            console.log(chalk.red(`        Execution Failed: ${executionResult.error}`));
        } else {
            if (compilationResult.threeAddressCodeFile) {
                console.log(`        Three Address Code: ${compilationResult.threeAddressCodeFile.path}`);
            }
            console.log(`        Source: ${compilationResult.sourceFile.path}`);
            console.log(`        Binary: ${compilationResult.binaryFile.path}`);
            if (!testPassed) {
                let log =
                    testCase.exitCode == executionResult.exitCode
                        ? s => console.log(s)
                        : s => console.log(chalk.red(s));
                log(`        Expected Exit Code: ${testCase.exitCode}`);
                log(`        Actual Exit Code: ${testCase.exitCode}`);

                log = testCase.stdout == executionResult.stdout ? s => console.log(s) : s => console.log(chalk.red(s));
                log(`        Expected stdout: ${testCase.stdout}`);
                log(`        Actual stdout: ${executionResult.stdout}`);
            }
            console.log(`        Debug: ${compilationResult.debugInstructions}`);
            console.log('');
        }
    }

    await prompt({
        type: 'confirm',
        message: 'Holding temporary files. Press Enter when you are done to exit. Temporary files may be removed.',
        name: 'unused',
    });
})();
