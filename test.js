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
    t.deepEqual(parse(lex(' return (5)')), ({
        type: 'returnStatement',
        children: [{
            type: 'return',
            value: null,
        }, {
            type: 'number',
            value: 5
        }]
    }));
});

test('ast for number in double brackets', t => {
    t.deepEqual(parse(lex('return ((20))')), ({
        type: 'returnStatement',
        children: [{
            type: 'return',
            value: null,
        }, {
            type: 'number',
            value: 20,
        }],
    }));
});

test('ast for product with brackets', t => {
    t.deepEqual(parse(lex('return 3 * (4 * 5)')), ({
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
                type: 'product',
                children: [{
                    type: 'number',
                    value: 4
                }, {
                    type: 'number',
                    value: 5
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
    expectedAst,
    printSubsteps = [],
}) => {
    // Make sure it parses
    const lexResult = lex(source);
    lexResult.forEach(({ string, type }) => {
        if (type === 'invalid') {
            t.fail(`Unable to lex. Invalid token: ${string}`);
        }
    });

    if (printSubsteps.includes('tokens')) {
        console.log(JSON.stringify(lexResult, 0, 2));
    }

    const parseResult = parse(lexResult);
    if (parseResult.error === 'Unable to parse') {
        t.fail(`Unable to parse "${source}"`);
    }

    if (printSubsteps.includes('ast')) {
        console.log(JSON.stringify(parseResult, 0, 2));
    }

    // Check the AST if asked
    if (expectedAst) {
        t.deepEqual(parseResult, expectedAst);
    }

    // C backend
    const cFile = await tmp.file({ postfix: '.c' });
    const exeFile = await tmp.file();
    const cSource = compile({ source, target: 'c' });

    if (printSubsteps.includes('c')) {
        console.log(cSource);
    }

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

    if (printSubsteps.includes('mips')) {
        console.log(mipsSource);
    }

    t.deepEqual(typeof mipsSource, 'string')
    await fs.writeFile(mipsFile.fd, mipsSource);

    try {
        const result = await exec(`spim -file ${mipsFile.path}`);
        if (result.stderr !== '') {
            t.fail(`Spim error. Mips text: ${mipsSource}\n error text: ${result.stderr}`);
        }
        debugger;
    } catch (e) {
        t.fail('Exception');
    }

    const mipsExitCode = await execAndGetExitCode(`bash -c `);
    if (mipsExitCode !== expectedExitCode) {
        t.fail(`mips returned ${mipsExitCode} when it should have returned ${expectedExitCode}: ${mipsSource}`);
    }
    t.pass();
};

test('lowering of bracketedExpressions', t => {
    t.deepEqual((parse(lex('return (8 * ((7)))'))), {
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

test('double product', compileAndRunMacro, {
    source: 'return 5 * 3 * 4',
    expectedExitCode: 60,
    expectedAst: {
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
    expectedAst: {
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

test('assign function and return', compileAndRunMacro, {
    source: 'constThree = a => 3; return 10',
    expectedExitCode: 10,
});

test('assign function and call it', compileAndRunMacro, {
    source: 'takeItToEleven = a => 11; return takeItToEleven(0)',
    expectedExitCode: 11
});

test('multiple variables called', compileAndRunMacro, {
    source: `
const11 = a => 11
const12 = a => 12
return const11(1) * const12(2)`,
    expectedExitCode: 132,
});

test('double product with brackets', compileAndRunMacro, {
    source: 'return 2 * (3 * 4) * 5',
    expectedExitCode: 120,
    expectedAst: {
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
                    value: 2
                }, {
                    type: 'product',
                    children: [{
                        type: 'number',
                        value: 3,
                    }, {
                        type: 'number',
                        value: 4,
                    }]
                }],
            }, {
                type: 'number',
                value: 5,
            }],
        }],
    },
});

test('id function', compileAndRunMacro, {
    source: 'id = a => a; return id(5)',
    expectedExitCode: 5,
});

test('double function', compileAndRunMacro, {
    source: 'doubleIt = a => 2 * a; return doubleIt(100)',
    expectedExitCode: 200,
});

test('subtraction', compileAndRunMacro, {
    source: 'return 7 - 5',
    expectedExitCode: 2,
});

test('order of operations', compileAndRunMacro, {
    source: 'return 2 * 5 - 1',
    expectedExitCode: 9,
});

test('associativity of subtraction', compileAndRunMacro, {
    source: 'return 5 - 2 - 1',
    expectedExitCode: 2,
});

test('ternary true', compileAndRunMacro, {
    source: 'return 1 ? 5 : 6',
    expectedExitCode: 5,
});

test('ternary false', compileAndRunMacro, {
    source: 'return 0 ? 5 : 6',
    expectedExitCode: 6,
});

test('ternary in function true', compileAndRunMacro, {
    source: `
ternary = a => a ? 9 : 5
return ternary(0)`,
    expectedExitCode: 5,
});

test('ternary in function then subtract', compileAndRunMacro, {
    source: `
ternary = a => a ? 9 : 3
return ternary(1) - ternary(0)`,
    expectedExitCode: 6,
});

test('equality comparison true', compileAndRunMacro, {
    source: `
isFive = five => five == 5 ? 2 : 7
return isFive(5)`,
    expectedExitCode: 2,
});

test('equality comparison false', compileAndRunMacro, {
    source: `
isFive = notFive => notFive == 5 ? 2 : 7
return isFive(11)`,
    expectedExitCode: 7,
});

test.only('factorial', compileAndRunMacro, {
    source: `
factorial = x => x == 1 ? 1 : x * factorial(x - 1)
return factorial(5)`,
    expectedExitCode: 120,
});

/* Needs types
test.failing('myVar = 3 * 3 return 9', compileAndRunMacro, {
    source: 'myVar = 3 * 3 return 9',
    expectedExitCode: 9,
});
*/
