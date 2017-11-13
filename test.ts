import test from 'ava';

import { lex, TokenType } from './lex.js';

import {
    parse,
    compile,
    CompilationResult,
} from './frontend.js';

import { file as tmpFile} from 'tmp-promise';
import { writeFile } from 'fs-extra';
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
    t.deepEqual(lex('return "test string"'), [
        { type: 'return', value: null, string: 'return' },
        { type: 'stringLiteral', value: 'test string', string: 'test string' },
    ]);
});

test('lex with initial whitespace', t => {
    t.deepEqual(lex(' 123'), [
        { type: 'number', value: 123, string: '123' },
    ]);
});

test('ast for single number', t => {
    t.deepEqual(parse(lex('return 7')), {
        parseErrors: [],
        ast: {
            type: 'returnStatement',
            children: [{
                type: 'return',
                value: null,
            }, {
                type: 'number',
                value: 7,
            }]
        },
    });
});

test('ast for number in brackets', t => {
    t.deepEqual(parse(lex(' return (5)')), ({
        parseErrors: [],
        ast: {
            type: 'returnStatement',
            children: [{
                type: 'return',
                value: null,
            }, {
                type: 'number',
                value: 5
            }]
        },
    }));
});

test('ast for number in double brackets', t => {
    t.deepEqual(parse(lex('return ((20))')), ({
        parseErrors: [],
        ast: {
            type: 'returnStatement',
            children: [{
                type: 'return',
                value: null,
            }, {
                type: 'number',
                value: 20,
            }],
        },
    }));
});

test('ast for product with brackets', t => {
    t.deepEqual(parse(lex('return 3 * (4 * 5)')), ({
        parseErrors: [],
        ast: {
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
        },
    }));
});

test('ast for assignment then return', t => {
    const expected = {
        parseErrors: [],
        ast: {
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
                        type: 'arg',
                        children: [{
                            type: 'identifier',
                            value: 'a'
                        }, {
                            type: 'colon',
                            value: null,
                        }, {
                            type: 'type',
                            value: 'Integer',
                        }],
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
        },
    };
    const astWithSemicolon = parse(lex('constThree = a: Integer => 3; return 10'));
    const astWithNewline = parse(lex('constThree = a: Integer => 3\n return 10'));

    t.deepEqual(astWithSemicolon, expected);
    t.deepEqual(astWithNewline, expected);
});

const execAndGetExitCode = async command => {
    try {
        await exec(command);
    } catch (e) {
        if (typeof e.code === 'number') {
            return e.code;
        } else {
            throw `Couldn't get exit code: ${e}`;
        }
    }
    return 0;
};

type CompileAndRunOptions = {
    source: string,
    expectedExitCode: number,
    expectedTypeErrors: [any],
    expectedParseErrors: [any],
    expectedAst: [any],
    printSubsteps?: ('js' | 'tokens' | 'ast' | 'c' | 'mips')[],
}

const compileAndRun = async (t, {
    source,
    expectedExitCode,
    expectedTypeErrors,
    expectedParseErrors,
    expectedAst,
    printSubsteps = [],
} : CompileAndRunOptions) => {
    // Make sure it parses
    const lexResult = lex(source);
    lexResult.forEach(({ string, type }) => {
        if (type === 'invalid') {
            t.fail(`Unable to lex. Invalid token: ${string}`);
        }
    });

    if (printSubsteps.includes('tokens')) {
        console.log(JSON.stringify(lexResult, null, 2));
    }

    const parseResult = parse(lexResult);
    if (printSubsteps.includes('ast')) {
        console.log(JSON.stringify(parseResult, null, 2));
    }

    // Frontend
    if (expectedAst) {
        t.deepEqual(parseResult, expectedAst);
    }

    // JS backend
    const jsFile = await tmpFile({ postfix: '.js' });
    const jsResult = compile({ source, target: 'js' });

    if (printSubsteps.includes('js')) {
        console.log(jsResult.code);
    }

    if (expectedParseErrors) {
        t.deepEqual(expectedParseErrors, jsResult.parseErrors);
        return;
    } else if ((jsResult.parseErrors as any).length > 0) {
        t.fail(`Found parse errors when none expected: ${(jsResult.parseErrors as any).join(', ')}`);
        return;
    }

    if (expectedTypeErrors) {
        t.deepEqual(expectedTypeErrors, jsResult.typeErrors);
        return;
    } else if ((jsResult.typeErrors as any).length > 0) {
        t.fail(`Found type errors when none expected: ${(jsResult.typeErrors as any).join(', ')}`);
        return;
    }

    await writeFile(jsFile.fd, jsResult.code);
    try {
        const jsExitCode = await execAndGetExitCode(`node ${jsFile.path}`);
        if (jsExitCode !== expectedExitCode) {
            t.fail(`JS returned ${jsExitCode} when it should have returned ${expectedExitCode}: ${jsResult.code}`);
        }
   } catch (e) {
       t.fail(`JS failed completely with "${e.msg}: ${jsResult.code}`);
   }

    // C backend
    const cFile = await tmpFile({ postfix: '.c' });
    const exeFile = await tmpFile();
    const result: CompilationResult = compile({ source, target: 'c' });;
    const cSource = result.code;

    if (printSubsteps.includes('c')) {
        console.log(cSource);
    }

    await writeFile(cFile.fd, cSource);
    try {
        await exec(`clang -Wall -Werror ${cFile.path} -o ${exeFile.path}`);
    } catch (e) {
        t.fail(`Failed to compile generated C code: ${cSource}. Errors: ${e.stderr}`);
    }
    try {
        const cExitCode = await execAndGetExitCode(exeFile.path);
        if (cExitCode !== expectedExitCode) {
            t.fail(`C returned ${cExitCode} when it should have returned ${expectedExitCode}: ${cSource}`);
        }
    } catch (e) {
       t.fail(`C failed completely with "${e}: ${cSource}`);
    }

    // Mips backend
    const mipsFile = await tmpFile({ postfix: '.s' });
    const mipsSource = compile({ source, target: 'mips' }).code;

    if (printSubsteps.includes('mips')) {
        console.log(mipsSource);
    }

    t.deepEqual(typeof mipsSource, 'string')
    await writeFile(mipsFile.fd, mipsSource);

    try {
        const result = await exec(`spim -file ${mipsFile.path}`);
        if (result.stderr !== '') {
            t.fail(`Spim error. Mips text: ${mipsSource}\n error text: ${result.stderr}`);
        }
        const lines = result.stdout.split('\n');
        const mipsExitCode = parseInt(lines[lines.length - 1]);
        if (mipsExitCode !== expectedExitCode) {
            t.fail(`mips returned ${mipsExitCode} when it should have returned ${expectedExitCode}: ${mipsSource}`);
        }
    } catch (e) {
        t.fail(`Exception: ${e.message}\nmips source: ${mipsSource}`);
    }

    t.pass();
};

test('lowering of bracketedExpressions', t => {
    t.deepEqual(parse(lex('return (8 * ((7)))')), {
        parseErrors: [],
        ast: {
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
        },
    });
});

test('bare return', compileAndRun, {
    source: 'return 7',
    expectedExitCode: 7,
});


test('single product', compileAndRun, {
    source: 'return 2 * 2',
    expectedExitCode: 4,
});

test('double product', compileAndRun, {
    source: 'return 5 * 3 * 4',
    expectedExitCode: 60,
    expectedAst: {
        parseErrors: [],
        ast: {
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
        },
    },
});

test('brackets', compileAndRun, {
    source: 'return (3)',
    expectedExitCode: 3,
});

test('brackets product', compileAndRun, {
    source: 'return (3 * 4) * 5',
    expectedExitCode: 60,
    expectedAst: {
        parseErrors: [],
        ast: {
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
    },
});

test('assign function and return', compileAndRun, {
    source: 'constThree = a: Integer => 3; return 10',
    expectedExitCode: 10,
});

test('assign function and call it', compileAndRun, {
    source: 'takeItToEleven = a: Integer => 11; return takeItToEleven(0)',
    expectedExitCode: 11
});

test('multiple variables called', compileAndRun, {
    source: `
const11 = a: Integer => 11
const12 = a: Integer => 12
return const11(1) * const12(2)`,
    expectedExitCode: 132,
});

test('double product with brackets', compileAndRun, {
    source: 'return 2 * (3 * 4) * 5',
    expectedExitCode: 120,
    expectedAst: {
        parseErrors: [],
        ast: {
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
    },
});

test('id function', compileAndRun, {
    source: 'id = a: Integer => a; return id(5)',
    expectedExitCode: 5,
});

test('double function', compileAndRun, {
    source: 'doubleIt = a: Integer => 2 * a; return doubleIt(100)',
    expectedExitCode: 200,
});

test('subtraction', compileAndRun, {
    source: 'return 7 - 5',
    expectedExitCode: 2,
});

test('order of operations', compileAndRun, {
    source: 'return 2 * 5 - 1',
    expectedExitCode: 9,
});

test('associativity of subtraction', compileAndRun, {
    source: 'return 5 - 2 - 1',
    expectedExitCode: 2,
});

test('ternary true', compileAndRun, {
    source: 'return 1 == 1 ? 5 : 6',
    expectedExitCode: 5,
});

test('ternary false', compileAndRun, {
    source: 'return 0 == 1 ? 5 : 6',
    expectedExitCode: 6,
});

test('parse error', compileAndRun, {
    source: '=>',
    expectedParseErrors: ['Expected identifier or return, found fatArrow'],
});

test('ternary in function false', compileAndRun, {
    source: `
ternary = a: Boolean => a ? 9 : 5
return ternary(false)`,
    expectedExitCode: 5,
});

test('ternary in function then subtract', compileAndRun, {
    source: `
ternaryFunc = a:Boolean => a ? 9 : 3
return ternaryFunc(true) - ternaryFunc(false)`,
    expectedExitCode: 6,
});

test('equality comparison true', compileAndRun, {
    source: `
isFive = five: Integer => five == 5 ? 2 : 7
return isFive(5)`,
    expectedExitCode: 2,
});

test('equality comparison false', compileAndRun, {
    source: `
isFive = notFive: Integer => notFive == 5 ? 2 : 7
return isFive(11)`,
    expectedExitCode: 7,
});

test('factorial', compileAndRun, {
    source: `
factorial = x: Integer => x == 1 ? 1 : x * factorial(x - 1)
return factorial(5)`,
    expectedExitCode: 120,
});

test('return bool fail', compileAndRun, {
    source: 'return 1 == 2',
    expectedTypeErrors: ['You tried to return a Boolean'],
});

test('boolean literal false', compileAndRun, {
    source: `return false ? 1 : 2`,
    expectedExitCode: 2,
});

test('boolean literal true', compileAndRun, {
    source: `return true ? 1 : 2`,
    expectedExitCode: 1,
});

test('wrong type for arg', compileAndRun, {
    source: `
boolFunc = a: Boolean => 1
return boolFunc(7)`,
    expectedTypeErrors: ['You passed a Integer as an argument to boolFunc. It expects a Boolean'],
});

test('assign wrong type', compileAndRun, {
    source: 'myInt: Integer = false; return myInt;',
    expectedTypeErrors: ['You tried to assign a Boolean to "myInt", which has type Integer'],
});

// Needs function types with args in syntax
test.failing('assign function to typed var', compileAndRun, {
    source: 'myFunc: Function = a: Integer => a; return a(37);',
    expectedExitCode: 37,
});

test('return local integer', compileAndRun, {
    source: 'myVar: Integer = 3 * 3; return myVar',
    expectedExitCode: 9,
});

test('many temporaries, spill to ram', compileAndRun, {
    source: 'return 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1 * 1',
    expectedExitCode: 1,
});

test('multi statement function with locals', compileAndRun, {
    source: `
quadrupleWithLocal = a: Integer => { b: Integer = 2 * a; return 2 * b }
return quadrupleWithLocal(5);`,
    expectedExitCode: 20,
});

test('mutil statement function with type error', compileAndRun, {
    source: `
boolTimesInt = a: Integer => { b: Boolean = false; return a * b }
return boolTimesInt(1);`,
    expectedTypeErrors: ['Right hand side of product was not integer'],
});

// TODO: rethink statment separators
test.failing('multi statement function on multiple lines', compileAndRun, {
    source: `
quadrupleWithLocal = a: Integer => {
    b: Integer = 2 * a
    return 2 * b
}

return quadrupleWithLocal(5);`,
    expectedExitCode: 20,
});

test('string length', compileAndRun, {
    source: `myStr: String = "test"; return length(myStr);`,
    expectedExitCode: 4,
});

// TODO: Fix this. No idea why this fails when non-inferred length works.
test.only('string type inferred', compileAndRun, {
    source: `myStr = "test2"; return length(myStr);`,
    expectedExitCode: 5,
});

// TODO: Mips doesn't actually malloc, it aliases. Fix that.
test('string copy', compileAndRun, {
    source: `myStr1: String = "testing"; myStr2: String = myStr1; return length(myStr2);`,
    expectedExitCode: 7,
});

test('string equality: equal', compileAndRun, {
    source: `str1 = "a"
str2 = "a"
return str1 == str2 ? 1 : 2
`,
    expectedExitCode: 1
});

// TODO: Fix allocations
test('string equality: inequal same length', compileAndRun, {
    source: `str1 = "a"
str2 = "b"
return str1 == str2 ? 1 : 2
`,
    expectedExitCode: 2
});

test('string equality: inequal different length', compileAndRun, {
    source: `str1 = "aa"
str2 = "a"
return str1 == str2 ? 1 : 2
`,
    expectedExitCode: 2,
});

test('wrong type global', compileAndRun, {
    source: `str: String = 5; return length(str)`,
    expectedTypeErrors: ['You tried to assign a Integer to "str", which has type String'],
});
