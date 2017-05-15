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

const execAndGetExitCode = async command => {
    try {
        await exec(command);
    } catch (e) {
        return e.code;
    }
    return 0;
};

const testProgram = (source, expectedExitCode) => {
    test('runs in c', async t => {
        const cFile = await tmp.file({ postfix: '.c'});
        const exeFile = await tmp.file();
        await fs.writeFile(cFile.fd, compile({ source, target: 'c' }));
        await exec(`clang ${cFile.path} -o ${exeFile.path}`);
        const exitCode = await execAndGetExitCode(exeFile.path);
        t.deepEqual(exitCode, expectedExitCode);
    });

    test('runs in js', async t => {
        const jsFile = await tmp.file({ postfix: '.js' });
        await fs.writeFile(jsFile.fd, compile({ source, target: 'js' }));
        const exitCode = await execAndGetExitCode(`node ${jsFile.path}`);
        t.deepEqual(exitCode, expectedExitCode);
    });
}

testProgram('7', 7);
testProgram('2 + 2', 4);

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
