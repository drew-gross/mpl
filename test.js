import test from 'ava';

import {
    parse,
    compile,
    lex,
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
    t.deepEqual(lex('a'), [
        { type: 'invalid', value: 'a' },
    ]);
    t.deepEqual(lex('(1)'), [
        { type: 'leftBracket', value: null },
        { type: 'number', value: 1 },
        { type: 'rightBracket', value: null },
    ]);
});

test('ast for single number', t => {
    t.deepEqual(parse(lex('7')), {
        type: 'program',
        children: [{
            type: 'expression',
            children: [{
                type: 'number',
                value: 7,
            }]
        }]
    });
});

test('ast for number in brackets', t => {
    t.deepEqual(parse(lex('(5)')), {
        type: 'program',
        children: [{
            type: 'expression',
            children: [{
                type: 'expression',
                children: [{
                    type: 'leftBracket',
                    value: null
                }, {
                    type: 'expression',
                    children: [{ type: 'number', value: 5 }],
                }, {
                    type: 'rightBracket',
                    value: null,
                }]
            }],
        }]
    });
});

test('ast for number in double brackets', t => {
    t.deepEqual(parse(lex('((20))')), {
        type: 'program',
        children: [{
            type: 'expression',
            children: [{
                type: 'expression',
                children: [{
                    type: 'leftBracket',
                    value: null
                }, {
                    type: 'expression',
                    children: [{
                        type: 'expression',
                        children: [{
                            type: 'leftBracket',
                            value: null
                        }, {
                            type: 'expression',
                            children: [{
                                type: 'number',
                                value: 20,
                            }],
                        }, {
                            type: 'rightBracket',
                            value: null,
                        }],
                    }],
                }, {
                    type: 'rightBracket',
                    value: null,
                }]
            }],
        }],
    });
});

test('ast for double product', t => {
    t.deepEqual(parse(lex('3 * (4 * 5)')), {
        "type": "program",
        "children": [{
            "type": "expression",
            "children": [{
                "type": "product",
                "children": [{
                    "type": "product",
                    "children": [{
                        "type": "number",
                        "value": 3
                    }, {
                        "type": "product",
                        "value": null
                    }, {
                        "type": "expression",
                        "children": [{
                            "type": "expression",
                            "children": [{
                                "type": "leftBracket",
                                "value": null
                            }, {
                                "type": "expression",
                                "children": [{
                                    "type": "product",
                                    "children": [{
                                        "type": "product",
                                        "children": [{
                                            "type": "number",
                                            "value": 4
                                        }, {
                                            "type": "product",
                                            "value": null
                                        }, {
                                            "type": "expression",
                                            "children": [{
                                                "type": "number",
                                                "value": 5
                                            }]
                                        }]
                                    }]
                                }]
                            }, {
                                "type": "rightBracket",
                                "value": null
                            }]
                        }]
                    }]
                }]
            }]
        }]
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
    test(`${source} runs in c`, async t => {
        const cFile = await tmp.file({ postfix: '.c'});
        const exeFile = await tmp.file();
        await fs.writeFile(cFile.fd, compile({ source, target: 'c' }));
        await exec(`clang ${cFile.path} -o ${exeFile.path}`);
        const exitCode = await execAndGetExitCode(exeFile.path);
        t.deepEqual(exitCode, expectedExitCode);
    });

    test(`${source} runs in js`, async t => {
        const jsFile = await tmp.file({ postfix: '.js' });
        await fs.writeFile(jsFile.fd, compile({ source, target: 'js' }));
        const exitCode = await execAndGetExitCode(`node ${jsFile.path}`);
        t.deepEqual(exitCode, expectedExitCode);
    });
};
/*
testProgram('7', 7);
testProgram('2 * 2', 4);
testProgram('(3)', 4);
*/
