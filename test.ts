import test from 'ava';
import { Backend, BackendInputs } from './api.js';

import { lex, TokenType } from './lex.js';

import {
    parse,
    compile,
} from './frontend.js';

import mipsBackend from './backends/mips.js';
import jsBackend from './backends/js.js';
import cBackend from './backends/c.js';

import { file as tmpFile} from 'tmp-promise';
import { writeFile } from 'fs-extra';
import debug from './util/debug.js';

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

type CompileAndRunOptions = {
    source: string,
    expectedExitCode: number,
    expectedTypeErrors: [any],
    expectedParseErrors: [any],
    expectedAst: [any],
    printSubsteps?: string[],
    debugSubsteps?: string[],
    failing?: string[],
}

const astToString = ast => {
    if (!ast) debug();
    switch (ast.type) {
        case 'returnStatement':
            return `return ${astToString(ast.children[1])}`;
        case 'ternary':
            return `${astToString(ast.children[0])} ? ${astToString(ast.children[2])} : ${astToString(ast.children[4])}`;
        case 'equality':
            return `${astToString(ast.children[0])} == ${astToString(ast.children[2])}`;
        case 'identifier':
            return ast.value;
        case 'number':
            return ast.value.toString();
        case 'typedAssignment':
            return `${astToString(ast.children[0])}: ${astToString(ast.children[2])} = ${astToString(ast.children[4])}`;
        case 'assignment':
            return `${astToString(ast.children[0])} = ${astToString(ast.children[2])}`;
        case 'callExpression':
            return `${astToString(ast.children[0])}(${astToString(ast.children[2])})`;
        case 'functionLiteral':
            return ast.value;
        case 'type':
            return ast.value;
        case 'product':
            return `${astToString(ast.children[0])} * ${astToString(ast.children[1])}`;
        case 'subtraction':
            return `${astToString(ast.children[0])} - ${astToString(ast.children[1])}`;
        default:
            debugger
            throw 'debugger';
    }
};

const compileAndRun = async (t, {
    source,
    expectedExitCode,
    expectedTypeErrors,
    expectedParseErrors,
    expectedAst,
    printSubsteps = [],
    debugSubsteps = [],
    failing = [],
} : CompileAndRunOptions) => {
    const printableSubsteps = ['js', 'tokens', 'ast', 'c', 'mips', 'structure'];
    printSubsteps.forEach(substepToPrint => {
        if (!printSubsteps.includes(substepToPrint)) {
            t.fail(`${substepToPrint} is not a printable substep`);
        }
    });

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
    const frontendOutput = compile(source);
    if (expectedParseErrors && 'parseErrors' in frontendOutput) {
        t.deepEqual(expectedParseErrors, (frontendOutput as { parseErrors: string[] }).parseErrors);
        return;
    } else if ('parseErrors' in frontendOutput) {
        t.fail(`Found parse errors when none expected: ${(frontendOutput as { parseErrors: string[] }).parseErrors.join(', ')}`);
    } else if (expectedParseErrors) {
        t.fail('Expected parse errors and none found');
    }

    if (expectedTypeErrors && 'typeErrors' in frontendOutput) {
        t.deepEqual(expectedTypeErrors, (frontendOutput as { typeErrors: string[] }).typeErrors);
        return;
    } else if ('typeErrors' in frontendOutput) {
        t.fail(`Found type errors when none expected: ${(frontendOutput as { typeErrors: string[] }).typeErrors.join(', ')}`);
    } else if (expectedTypeErrors) {
        t.fail('Expected type errors and none found');
    }

    if (printSubsteps.includes('structure')) {
        const structure = frontendOutput as BackendInputs;
        console.log('Functions:');
        structure.functions.forEach(f => {
            console.log(`-> ${f.name}(${f.argument.children[0].value})`);
            f.statements.forEach(statement => {
                console.log(`---> `, astToString(statement));
            });
        });
        console.log('Program:');
        console.log('-> Globals:');
        structure.globalDeclarations.forEach(declaration => {
            console.log(`---> ${declaration.type.name} ${declaration.name}`);
        });
        console.log('-> Statements:');
        structure.program.statements.forEach(statement => {
            console.log(`---> `, astToString(statement));
        });
    }

    // Backends
    const backends: Backend[] = [jsBackend, cBackend, mipsBackend];
    for (let i = 0; i < backends.length; i++) {
        const backend = backends[i];
        const exeFile = await tmpFile({ postfix: `.${backend.name}` });
        const exeContents = backend.toExectuable(frontendOutput);
        if (printSubsteps.includes(backend.name)) {
            console.log(exeContents);
        }
        await writeFile(exeFile.fd, exeContents);

        if (debugSubsteps.includes(backend.name)) {
            if (backend.debug) {
                await backend.debug(exeFile.path);
            } else {
                t.fail(`${backend.name} doesn't define a debugger`);
            }
        }
        const result = await backend.execute(exeFile.path);

        if (result !== expectedExitCode && !failing.includes(backend.name)) {
            t.fail(`${backend.name} returned ${result} when it should have returned ${expectedExitCode}: ${/*exeContents*/''}`);
        }
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
    expectedExitCode: 11,
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

test('empty string length', compileAndRun, {
   source: `myStr: String = ""; return length(myStr);`,
   expectedExitCode: 0,
});

test('string length with type inferred', compileAndRun, {
    source: `myStr = "test2"; return length(myStr);`,
    expectedExitCode: 5,
});

test('struture is equal for inferred string type', t => {
    const inferredStructure = compile('myStr = "test"; return length(myStr);');
    const suppliedStructure = compile('myStr: String = "test"; return length(myStr);');
    t.deepEqual(inferredStructure, suppliedStructure);
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
