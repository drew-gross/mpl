import { compile } from '../frontend.js';
import { readFile, writeFile } from 'fs-extra';
import jsBackend from '../backends/js.js';

if (process.argv.length != 4) {
    console.log('Usage: mpl <input> <output>');
    process.exit(-1);
}

let [_, __, inputPath, outputPath] = process.argv;

(async () => {
    const input = await readFile(inputPath, 'utf8');
    const frontendOutput = compile(input);
    // TODO: better way to report these specific errors. Probably muck with the type of ExecutionResult.
    if (
        'parseErrors' in frontendOutput ||
        'typeErrors' in frontendOutput ||
        'kind' in frontendOutput ||
        'internalError' in frontendOutput
    ) {
        console.log(frontendOutput);
        process.exit(-1);
    }
    const backendOutput = await jsBackend.compile(frontendOutput);
    if ('error' in backendOutput) {
        console.log(backendOutput);
        process.exit(-1);
    }
    await writeFile(outputPath, backendOutput.source);
})();
