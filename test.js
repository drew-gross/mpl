import test from 'ava';

import {
    parse,
    compile,
    lex,
} from './compiler';

import tmp from 'tmp-promise';
import fs from 'fs-extra';
import { exec } from 'child-process-promise';

test('parse no tokens', t => {
    t.deepEqual(parse([]), null);
});

test('ast for single number', t => {
    t.deepEqual(parse(lex('7')), {
        type: 'number',
        children: [
            { type: 'number', value: 7 },
        ]
    });
});

test('compile and run c', async t => {
    const cFile = await tmp.file({ postfix: '.c'});
    const exeFile = await tmp.file();
    await fs.writeFile(cFile.fd, compile({
        source: '7',
        target: 'c',
    }));
    await exec(`clang ${cFile.path} -o ${exeFile.path}`);
    try {
        await exec(exeFile.path);
    } catch (e) {
        t.deepEqual(e.code, 7);
    }
});

test('compile and run js', async t => {
    const jsFile = await tmp.file({ postfix: '.js'});
    await fs.writeFile(jsFile.fd, compile({
        source: '7',
        target: 'js',
    }));
    try {
        await exec(`node ${jsFile.path}`);
    } catch (e) {
        t.deepEqual(e.code, 7);
    }
});

test('lexer', t => {
    t.deepEqual(lex('123'), [
        { type: 'number', value: 123 },
    ]);
    t.deepEqual(lex('123 456'), [
        { type: 'number', value: 123 },
        { type: 'number', value: 456 },
    ]);
    t.deepEqual(lex('a'), [
        { type: 'invalid', value: null },
    ]);
});
