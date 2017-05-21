import test from 'ava';

import {
    parse,
    compile,
    lex,
    lowerBracketedExpressions,
} from './compiler';

import tmp from 'tmp-promise';
import fs from 'fs-extra';
import { exec } from 'child-process-promise';

test('lexer', t => {
    t.deepEqual(lex('123'), [
        { type: 'number', value: 123 },
    ]);
    t.deepEqual(lex('123 456'), [
        { type: 'number', value: 123 },
        { type: 'number', value: 456 },
    ]);
    t.deepEqual(lex('&&&&&'), [
        { type: 'invalid', value: '&&&&&' },
    ]);
    t.deepEqual(lex('(1)'), [
        { type: 'leftBracket', value: null },
        { type: 'number', value: 1 },
        { type: 'rightBracket', value: null },
    ]);
    t.deepEqual(lex('return 100'), [
        { type: 'return', value: null },
        { type: 'number', value: 100 },
    ]);
});

test('lex with initial whitespace', t => {
    t.deepEqual(lex(' 123'), [
        { type: 'number', value: 123 },
    ]);
});

test('ast for single number', t => {
    t.deepEqual(parse(lex('return 7')), {
        type: 'returnStatement',
        children: [{
            type: 'return',
            value: null,
        }, {
            type: 'number',
            value: 7,
        }]
    });
});

test('ast for number in brackets', t => {
    t.deepEqual(parse(lex(' return (5)')), {
        type: 'returnStatement',
        children: [{
            type: 'return',
            value: null,
        }, {
            type: 'bracketedExpression',
            children: [{
                type: 'leftBracket',
                value: null
            }, {
                type: 'number',
                value: 5
            }, {
                type: 'rightBracket',
                value: null,
            }]
        }]
    });
});

test('ast for number in double brackets', t => {
    t.deepEqual(parse(lex('return ((20))')), {
        type: 'returnStatement',
        children: [{
            type: 'return',
            value: null,
        }, {
            type: 'bracketedExpression',
            children: [{
                type: 'leftBracket',
                value: null
            }, {
                type: 'bracketedExpression',
                children: [{
                    type: 'leftBracket',
                    value: null
                }, {
                    type: 'number',
                    value: 20,
                }, {
                    type: 'rightBracket',
                    value: null,
                }],
            }, {
                type: 'rightBracket',
                value: null,
            }]
        }],
    });
});

test('ast for double product', t => {
    t.deepEqual(parse(lex('return 3 * (4 * 5)')), {
        type: 'returnStatement',
        children: [{
            type: 'return',
            value: null,
        }, {
            type: 'product1',
            children: [{
                type: 'number',
                value: 3
            }, {
                type: 'product',
                value: null
            }, {
                type: 'bracketedExpression',
                children: [{
                    type: 'leftBracket',
                    value: null
                }, {
                    type: 'product1',
                    children: [{
                        type: 'number',
                        value: 4
                    }, {
                        type: 'product',
                        value: null
                    }, {
                        type: 'number',
                        value: 5
                    }]
                }, {
                    type: 'rightBracket',
                    value: null
                }]
            }]
        }]
    });
});

test('ast for assignment then return', t => {
    t.deepEqual(parse(lex('myVar = 3 * 3 return 9')), {
        type: 'statement',
        children: [{
            type: 'statement',
            children: [{
                type: 'identifier',
                value: 'myVar',
            }, {
                type: 'assignment',
                value: null,
            }, {
                type: 'product1',
                children: [{
                    type: 'number',
                    value: 3,
                }, {
                    type: 'product',
                    value: null,
                }, {
                    type: 'number',
                    value: 3,
                }],
            }],
        }, {
            type: 'returnStatement',
            children: [{
                type: 'return',
                value: null,
            }, {
                type: 'number',
                value: 9,
            }],
        }],
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

const compileAndRunMacro = async (t, source, expectedExitCode) => {
    // C backend works fine
    const cFile = await tmp.file({ postfix: '.c'});
    const exeFile = await tmp.file();
    const cSource = compile({ source, target: 'c' });
    await fs.writeFile(cFile.fd, cSource);
    try {
        await exec(`clang ${cFile.path} -o ${exeFile.path}`);
    } catch (e) {
        t.fail(`Failed to compile generated C code: ${cSource}`);
    }
    const cExitCode = await execAndGetExitCode(exeFile.path);
    t.deepEqual(cExitCode, expectedExitCode);

    // JS backend works fine
    const jsFile = await tmp.file({ postfix: '.js' });
    const jsSource = compile({ source, target: 'js' });
    await fs.writeFile(jsFile.fd, jsSource);
    const jsExitCode = await execAndGetExitCode(`node ${jsFile.path}`);
    if (jsExitCode !== expectedExitCode) {
        t.fail(`JS returned ${jsExitCode} when it shold have returned ${expectedExitCode}: ${jsSource}`);
    } else {
        t.pass();
    }
};

test('lowering of bracketedExpressions', t => {
    t.deepEqual(lowerBracketedExpressions(parse(lex('return (8 * ((7)))'))), {
        type: 'returnStatement',
        children: [{
            type: 'return',
            value: null,
        }, {
            type: 'product1',
            children: [{
                type: 'number',
                value: 8
            }, {
                type: 'product',
                value: null,
            }, {
                type: 'number',
                value: 7,
            }],
        }],
    });
});

test('return 7', compileAndRunMacro, 'return 7', 7);
test('return 2 * 2', compileAndRunMacro, 'return 2 * 2', 4);
test('return (3)', compileAndRunMacro, 'return (3)', 3);
//test('myVar = 3 * 3 return 9', compileAndRunMacro, 'myVar = 3 * 3 return 9', 9);
