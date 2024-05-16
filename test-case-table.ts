import * as omitDeep from 'omit-deep';
import { testPrograms } from './test-cases';
import produceProgramInfo from './produceProgramInfo';
import * as chalk from 'chalk';
import * as assert from 'assert';
import * as Table from 'cli-table3';

(async () => {
    const t = new Table();

    let problems = 0;
    const color = st => {
        if (st == 'n/a') return chalk.yellow(st);
        if (st == 'ok') return chalk.green(st);
        problems++;
        return chalk.red(st);
    };

    t.push(['Test Name', 'Fail?', 'Inf?', 'Info?', 'Exc?', 'Parse?']);

    t.push(
        ...(await Promise.all(
            testPrograms.map(async p => {
                const testName = p.name;
                let failingOk = 'n/a';
                let infiniteLoopOk = 'n/a';
                let producedInfoOk = 'n/a';
                let exceptionOk = 'n/a';
                let parseOk = 'n/a';
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
                        parseOk = 'ok';

                        if (p.parseErrors) {
                            parseOk = 'exp';
                            return;
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
                ];
            })
        ))
    );

    console.log(t.toString());
    const expectedProblems = 60;
    if (problems != expectedProblems) {
        console.log(chalk.red(`${problems} Problems`));
    } else {
        console.log(chalk.green(`${problems} Problems`));
    }
    process.exit(problems == expectedProblems ? 0 : 1);
})();
