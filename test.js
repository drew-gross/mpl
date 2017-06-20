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
        { type: 'number', value: 123, string: '123' },
    ]);
    t.deepEqual(lex('123 456'), [
        { type: 'number', value: 123, string: '123' },
        { type: 'number', value: 456, string: '456' },
    ]);
    t.deepEqual(lex('&&&&&'), [
        { type: 'invalid', value: '&&&&&', string: '&&&&&' },
    ]);
    t.deepEqual(lex('(1)'), [
        { type: 'leftBracket', value: null, string: '(' },
        { type: 'number', value: 1, string: '1' },
        { type: 'rightBracket', value: null, string: ')' },
    ]);
    t.deepEqual(lex('return 100'), [
        { type: 'return', value: null, string: 'return' },
        { type: 'number', value: 100, string: '100' },
    ]);
});

test('lex with initial whitespace', t => {
    t.deepEqual(lex(' 123'), [
        { type: 'number', value: 123, string: '123' },
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
    t.deepEqual(parse(lex(' return (5)')), lowerBracketedExpressions({
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
    }));
});

test('ast for number in double brackets', t => {
    t.deepEqual(parse(lex('return ((20))')), lowerBracketedExpressions({
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
    }));
});

test('ast for product with brackets', t => {
    t.deepEqual(parse(lex('return 3 * (4 * 5)')), lowerBracketedExpressions({
        type: 'returnStatement',
        children: [{
            type: 'return',
            value: null,
        }, {
            type: 'product',
            children: [{
                type: 'number',
                value: 3
            }, {
                type: 'bracketedExpression',
                children: [{
                    type: 'leftBracket',
                    value: null
                }, {
                    type: 'product',
                    children: [{
                        type: 'number',
                        value: 4
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
    }));
});

test('ast for assignment then return', t => {
    const expected = {
        type: 'statement',
        children: [{
            type: 'assignment',
            children: [{
                type: 'identifier',
                value: 'constThree',
            }, {
                type: 'assignment',
                value: null,
            }, {
                type: 'function',
                children: [{
                    type: 'identifier',
                    value: 'a',
                }, {
                    type: 'fatArrow',
                    value: null,
                }, {
                    type: 'number',
                    value: 3,
                }],
            }],
        }, {
            type: 'statementSeparator',
            value: null,
        }, {
            type: 'returnStatement',
            children: [{
                type: 'return',
                value: null,
            }, {
                type: 'number',
                value: 10,
            }],
        }],
    };
    const astWithSemicolon = parse(lex('constThree = a => 3; return 10'));
    const astWithNewline = parse(lex('constThree = a => 3\n return 10'));

    t.deepEqual(astWithSemicolon, expected);
    t.deepEqual(astWithNewline, expected);
});

const execAndGetExitCode = async command => {
    try {
        await exec(command);
    } catch (e) {
        return e.code;
    }
    return 0;
};

const compileAndRunMacro = async (t, {
    source,
    expectedExitCode,
    expetedAst,
}) => {
    // Make sure it parses
    const parseResult = parse(lex(source));
    if (parseResult.error === 'Unable to parse') {
        t.fail(`Unable to parse "${source}"`);
    }

    const logAst = false;
    if (logAst) {
        console.log(JSON.stringify(parseResult, 0, 2));
    }

    // Check the AST if asked
    if (expetedAst) {
        t.deepEqual(parseResult, expetedAst);
    }

    // C backend
    const cFile = await tmp.file({ postfix: '.c' });
    const exeFile = await tmp.file();
    const cSource = compile({ source, target: 'c' });
    await fs.writeFile(cFile.fd, cSource);
    try {
        await exec(`clang ${cFile.path} -o ${exeFile.path}`);
    } catch (e) {
        t.fail(`Failed to compile generated C code: ${cSource}. Errors: ${e.stderr}`);
    }
    const cExitCode = await execAndGetExitCode(exeFile.path);
    if (cExitCode !== expectedExitCode) {
        t.fail(`C returned ${cExitCode} when it should have returned ${expectedExitCode}: ${cSource}`);
    }

    // JS backend
    const jsFile = await tmp.file({ postfix: '.js' });
    const jsSource = compile({ source, target: 'js' });
    await fs.writeFile(jsFile.fd, jsSource);
    const jsExitCode = await execAndGetExitCode(`node ${jsFile.path}`);
    if (jsExitCode !== expectedExitCode) {
        t.fail(`JS returned ${jsExitCode} when it should have returned ${expectedExitCode}: ${jsSource}`);
    }

    // Mips backend
    const mipsFile = await tmp.file({ postfix: '.s' });
    const mipsSource = compile({ source, target: 'mips' });
    t.deepEqual(typeof mipsSource, 'string')
    await fs.writeFile(mipsFile.fd, mipsSource);
    const mipsExitCode = await execAndGetExitCode(`bash -c 'exit \`spim -file ${mipsFile.path} | tail -n 1\`'`);
    if (mipsExitCode !== expectedExitCode) {
        t.fail(`mips returned ${mipsExitCode} when it should have returned ${expectedExitCode}: ${mipsSource}`);
    }
    t.pass();
};

test('lowering of bracketedExpressions', t => {
    t.deepEqual(lowerBracketedExpressions(parse(lex('return (8 * ((7)))'))), {
        type: 'returnStatement',
        children: [{
            type: 'return',
            value: null,
        }, {
            type: 'product',
            children: [{
                type: 'number',
                value: 8
            }, {
                type: 'number',
                value: 7,
            }],
        }],
    });
});

test('bare return', compileAndRunMacro, {
    source: 'return 7',
    expectedExitCode: 7,
});

test('single product', compileAndRunMacro, {
    source: 'return 2 * 2',
    expectedExitCode: 4,
});

// Needs temporaries
test.failing('double product', compileAndRunMacro, {
    source: 'return 5 * 3 * 4',
    expectedExitCode: 60,
    expetedAst: {
        type: 'returnStatement',
        children: [{
            type: 'return',
            value: null,
        }, {
            type: 'product',
            children: [{
                type: 'product',
                children: [{
                    type: 'number',
                    value: 5,
                }, {
                    type: 'number',
                    value: 3
                }]
            }, {
                type: 'number',
                value: 4,
            }]
        }],
    }
});

test('brackets', compileAndRunMacro, {
    source: 'return (3)',
    expectedExitCode: 3,
});

test('brackets product', compileAndRunMacro, {
    source: 'return (3 * 4) * 5',
    expectedExitCode: 60,
    expetedAst: {
        type: 'returnStatement',
        children: [{
            type: 'return',
            value: null,
        }, {
            type: 'product',
            children: [{
                type: 'product',
                children: [{
                    type: 'number',
                    value: 3,
                }, {
                    type: 'number',
                    value: 4,
                }],
            }, {
                type: 'number',
                value: 5,
            }],
        }],
    },
});

test.only('assign function and return', compileAndRunMacro, {
    source: 'constThree = a => 3; return 10',
    expectedExitCode: 10,
});

test('assign function and call it', compileAndRunMacro, {
    source: 'takeItToEleven = a => 11; return takeItToEleven(unused)',
    expectedExitCode: 11
});

test.failing('multiple variables called', compileAndRunMacro, {
    source: `
const11 = a => 11
const12 = a => 12
return const11(unused) * const12(unused)`,
    expectedExitCode: 132,
});


test.failing('double product with brackets', compileAndRunMacro, {
    source: 'return 2 * (3 * 4) * 5',
    expectedExitCode: 72,
    expetedAst: {
        type: 'returnStatement',
        children: [{
            type: 'return',
            value: null,
        }, {
            type: 'product1',
            children: [{
                type: 'product1',
                children: [{
                }],
            }, {
                type: 'product',
                value: null,
            }, {
                type: 'number',
                value: 5
            }],
        }],
    },
});

//test('myVar = 3 * 3 return 9', compileAndRunMacro, 'myVar = 3 * 3 return 9', 9);
