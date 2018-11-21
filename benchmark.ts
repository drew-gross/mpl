import { writeFile, readFile } from 'fs-extra';
import { file as tmpFile } from 'tmp-promise';
import testCases from './test-cases.js';
import { compile } from './frontend.js';
import { Backend } from './api.js';
import * as commander from 'commander';
import { zip } from 'lodash';

import mipsBackend from './backends/mips.js';
import jsBackend from './backends/js.js';
import cBackend from './backends/c.js';
import x64Backend from './backends/x64.js';

commander
    .option('--before <file>')
    .option('--after <file>')
    .option('--out <file>')
    .parse(process.argv);

const before = commander.before;
const after = commander.after;
const out = commander.out;

if ((before && !after) || (after && !before)) {
    console.log('--before and --after must be specified at the same time');
    process.exit(-1);
}

const fmtNum = num => (num < 0 ? num.toString() : '+' + num.toString());

if (!before) {
    (async () => {
        const results = await Promise.all(
            testCases
                .map(async ({ name, source }) => {
                    const frontendOutput = compile(source);
                    if ('parseErrors' in frontendOutput || 'typeErrors' in frontendOutput) {
                        console.log(`Failed to compile ${name}`);
                        return;
                    }
                    const [jsSize, cSize, mipsSize, x64Size] = await Promise.all(
                        [jsBackend, cBackend, mipsBackend, x64Backend].map(async backend => {
                            const exeContents = backend.toExectuable(frontendOutput);
                            const exeFile = await tmpFile({ postfix: `.${backend.name}` });
                            await writeFile(exeFile.fd, exeContents);
                            return await backend.binSize(exeFile.path);
                        })
                    );

                    return {
                        name,
                        'JS Binary Size (bytes)': jsSize,
                        'C Binary Size (bytes)': cSize,
                        'Mips Binary Size (bytes)': mipsSize,
                        'x64 Binary Size (bytes)': x64Size,
                    };
                })
                .filter(x => x !== undefined)
        );
        if (out) {
            await writeFile(out, JSON.stringify(results));
        } else {
            console.table(results);
        }
    })();
} else {
    (async () => {
        const beforeJson = JSON.parse(await readFile(before, 'utf8'));
        const afterJson = JSON.parse(await readFile(after, 'utf8'));
        const jsons = zip(beforeJson, afterJson);
        const comparisons = jsons.map(([before, after]) => {
            if (before.name != after.name) {
                console.log('Name mismatch! Make sure to generate before and after using the same test cases');
                process.exit(-1);
            }
            return {
                name: before.name,
                'JS Binary Size (% change)':
                    100 * (1 - before['JS Binary Size (bytes)'] / after['JS Binary Size (bytes)']),
                'C Binary Size (% change)':
                    100 * (1 - before['C Binary Size (bytes)'] / after['C Binary Size (bytes)']),
                'Mips Binary Size (% change)':
                    100 * (1 - before['Mips Binary Size (bytes)'] / after['Mips Binary Size (bytes)']),
                'x64 Binary Size (% change)':
                    100 * (1 - before['x64 Binary Size (bytes)'] / after['x64 Binary Size (bytes)']),
            };
        });
        console.table(comparisons);
    })();
}
