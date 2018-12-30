import testCases from './test-cases.js';
import { passed } from './test-case.js';
import produceProgramInfo from './produceProgramInfo.js';
import { file as tmpFile } from 'tmp-promise';
import { writeFile } from 'fs-extra';
import writeSvg from './util/graph/writeSvg.js';
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
        console.log(`Error in program: ${programInfo}`);
        return;
    }

    const tokensFile = await tmpFile({ postfix: '.json' });
    await writeFile(tokensFile.fd, JSON.stringify(programInfo.tokens, null, 2));
    console.log(`Tokens: ${tokensFile.path}`);

    const astFile = await tmpFile({ postfix: '.json' });
    await writeFile(astFile.fd, JSON.stringify(programInfo.ast, null, 2));
    console.log(`Ast: ${astFile.path}`);

    const dotText = dot.write(toDotFile(programInfo.ast));
    const svgFile = await tmpFile({ postfix: '.svg' });
    await writeSvg(dotText, svgFile.path);
    console.log(`Ast SVG: ${svgFile.path}`);

    const structureFile = await tmpFile({ postfix: '.txt' });
    await writeFile(structureFile.fd, programInfo.structure);
    console.log(`Structure: ${structureFile.path}`);

    const tacFile = await tmpFile({ postfix: '.txt' });
    await writeFile(tacFile.fd, programInfo.threeAddressCode.asString);
    console.log(`Three Address Code: ${tacFile.path}`);

    const roundTripParsedFile = await tmpFile({ postfix: '.txt' });
    await writeFile(roundTripParsedFile.fd, JSON.stringify(programInfo.threeAddressCode.roundTripParsed, null, 2));

    const roundTripSuccess =
        !Array.isArray(programInfo.threeAddressCode.roundTripParsed) &&
        !('kind' in programInfo.threeAddressCode.roundTripParsed);
    if (roundTripSuccess) {
        console.log(`Three Address Code Round Trip Parse: ${roundTripParsedFile.path}`);
    } else {
        console.log(chalk.red(`Three Address Code Round Trip Parse: ${roundTripParsedFile.path}`));
    }

    console.log('\nBackends:');
    for (let i = 0; i < programInfo.backendResults.length; i++) {
        const { name, targetSource, executionResult } = programInfo.backendResults[i];
        const testPassed = passed(testCase, executionResult);

        if (testPassed) {
            console.log(`    ${name}:`);
        } else {
            console.log(chalk.red(`    ${name}:`));
        }

        if ('error' in executionResult) {
            console.log(chalk.red(`        Execution Failed: ${executionResult.error}`));
        } else {
            const targetSourceFile = await tmpFile({ postfix: `.${name}` });
            await writeFile(targetSourceFile.fd, targetSource);
            console.log(`        Source: ${targetSourceFile.path}`);
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
            console.log('');
        }
    }

    await prompt({
        type: 'confirm',
        message: 'Holding temporary files. Press Enter when you are done to exit. Temporary files may be removed.',
        name: 'unused',
    });
})();
