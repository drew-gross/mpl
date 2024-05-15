import * as commander from 'commander';
// import { interpretProgram } from './interpreter';
import { readFile } from 'fs-extra';

(async () => {
    commander.arguments('<input>').parse(process.argv);
    const programText = await readFile(commander.args[0]);
    console.log(programText);
})();
