import { stat } from 'fs-extra';
import { writeFile, readFile } from 'fs-extra';
import { testPrograms } from './test-cases';
import { TestProgram } from './test-cases';
import { compile } from './frontend';
import { Backend } from './api';
import * as commander from 'commander';
import { zip } from 'lodash';

import mipsBackend from './backends/mips';
import jsBackend from './backends/js';
import cBackend from './backends/c';
import x64Backend from './backends/x64';

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

const fmtNum = num =>
    (num <= 0
        ? num.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })
        : '+' +
          num.toLocaleString(undefined, {
              maximumFractionDigits: 2,
              minimumFractionDigits: 2,
          })) + '%';

if (!before) {
    (async () => {
        const results = await Promise.all(
            testPrograms.map(async ({ name, source, failing }: TestProgram) => {
                if (failing) {
                    return;
                }
                const frontendOutput = compile(source);
                if (
                    'parseErrors' in frontendOutput ||
                    'typeErrors' in frontendOutput ||
                    'kind' in frontendOutput ||
                    'internalError' in frontendOutput
                ) {
                    console.log(`Failed to compile ${name}`);
                    return;
                }
                const backends: Backend[] = [jsBackend, cBackend, mipsBackend, x64Backend];
                const [jsSize, cSize, mipsSize, x64Size] = await Promise.all(
                    backends.map(async (backend: Backend) => {
                        const targetSource = await backend.compile(frontendOutput);
                        if ('error' in targetSource) {
                            throw new Error(
                                `Failed to compile ${name} to ${backend.name}: ${targetSource.error}`
                            );
                        }
                        const compilationResult = await backend.finishCompilation(
                            targetSource.target,
                            targetSource.tac
                        );
                        if ('error' in compilationResult) {
                            throw new Error(
                                `Failed to compile ${name} to ${backend.name}: ${compilationResult.error}`
                            );
                        }
                        return (await stat(compilationResult.binaryFile.path)).size;
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
        );
        const successfulResults = results.filter(Boolean);
        if (out) {
            await writeFile(out, JSON.stringify(successfulResults));
        } else {
            console.table(successfulResults);
        }
    })();
} else {
    (async () => {
        const beforeJson = JSON.parse(await readFile(before, 'utf8'));
        const afterJson = JSON.parse(await readFile(after, 'utf8'));
        const jsons = zip(beforeJson, afterJson);
        const comparisons = jsons.map(([beforeStat, afterStat]) => {
            if (beforeStat.name != afterStat.name) {
                console.log(
                    'Name mismatch! Make sure to generate before and after using the same test cases'
                );
                process.exit(-1);
            }
            return {
                name: beforeStat.name,
                'JS Binary Size': fmtNum(
                    100 *
                        -(
                            1 -
                            afterStat['JS Binary Size (bytes)'] /
                                beforeStat['JS Binary Size (bytes)']
                        )
                ),
                'C Binary Size': fmtNum(
                    100 *
                        -(
                            1 -
                            afterStat['C Binary Size (bytes)'] /
                                beforeStat['C Binary Size (bytes)']
                        )
                ),
                'Mips Binary Size': fmtNum(
                    100 *
                        -(
                            1 -
                            afterStat['Mips Binary Size (bytes)'] /
                                beforeStat['Mips Binary Size (bytes)']
                        )
                ),
                'x64 Binary Size': fmtNum(
                    100 *
                        -(
                            1 -
                            afterStat['x64 Binary Size (bytes)'] /
                                beforeStat['x64 Binary Size (bytes)']
                        )
                ),
            };
        });
        console.table(comparisons);
    })();
}
