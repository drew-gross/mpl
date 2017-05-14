import test from 'ava';

import {
    parse,
    evaluate,
    toC,
    toJS,
    lex,
} from './compiler';

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
    await exec(`clang ${cFile.path} -o ${exeFile.path}`);
    try {
        await exec(exeFile.path);
    } catch (e) {
        t.deepEqual(e.code, 7);
    }
});

test('compile and run js', async t => {
    const jsFile = await tmp.file({ postfix: '.js'});
    await fs.writeFile(jsFile.fd, toJS(parse('7')));
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
