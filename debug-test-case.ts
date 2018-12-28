import testCases from './test-cases.js';
import produceProgramInfo from './produceProgramInfo.js';
import { file as tmpFile } from 'tmp-promise';
import { writeFile } from 'fs-extra';
import writeSvg from './util/graph/writeSvg.js';
import { prompt } from 'inquirer';
import * as dot from 'graphlib-dot';
import { toDotFile } from './parser-lib/parse.js';
import { programToString } from './threeAddressCode/programToString.js';

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

    const programInfo = produceProgramInfo(testCase.source);

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
    await writeFile(tacFile.fd, programToString(programInfo.threeAddressCode));
    console.log(`Three Address Code: ${tacFile.path}`);

    // Wait for user to kill program so that temp files aren't cleaned up.
    await prompt();
})();
