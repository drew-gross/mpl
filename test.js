import test from 'ava';

import { parse, evaluate, toC } from './compiler';

import tmp from 'tmp-promise';
import fs from 'fs-extra';
import { exec } from 'child-process-promise';

test('parse empty file', t => {
    t.deepEqual(parse(''), {
        statements: [],
    });
});

test('parse single number', t => {
    t.deepEqual(parse('7'), {
        statements: [
            '7',
        ],
    });
});

test('evaluate single number', t => {
    t.deepEqual(evaluate(parse('7')), 7);
});

test('compile and run c', async t => {
    const cFile = await tmp.file({ postfix: '.c'});
    const exeFile = await tmp.file();
    await fs.writeFile(cFile.fd, toC(parse('7')));
    let contents = await fs.readFile(cFile.fd);
    await exec(`clang ${cFile.path} -o ${exeFile.path}`);
    try {
        await exec(exeFile.path);
    } catch (e) {
        t.deepEqual(e.code, 7);
    }
});
