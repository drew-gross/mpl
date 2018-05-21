import * as open from 'opn';
import { exec } from 'child-process-promise';
import { Backend, BackendInputs, TypeError } from './api.js';
import { Ast } from './ast.js';
import { lex } from './lex.js';
import { parseMpl, compile, parseErrorToString } from './frontend.js';
import { file as tmpFile } from 'tmp-promise';
import { writeFile, outputFile } from 'fs-extra';
import debug from './util/debug.js';
import join from './util/join.js';
import { tokenSpecs, grammar } from './grammar.js';
import { parse, stripResultIndexes, toDotFile, parseResultIsError, stripSourceLocation } from './parser-combinator.js';
import * as dot from 'graphlib-dot';

import mipsBackend from './backends/mips.js';
import jsBackend from './backends/js.js';
import cBackend from './backends/c.js';
import x64Backend from './backends/x64.js';

type CompileAndRunOptions = {
    source: string;
    expectedExitCode: number;
    expectedTypeErrors: [any];
    expectedParseErrors: [any];
    expectedStdOut: string;
    expectedAst: [any];
    printSubsteps?: string[] | string;
    debugSubsteps?: string[] | string;
    failing?: string[] | string;
    vizAst: boolean;
};

const astToString = (ast: Ast) => {
    if (!ast) debug('Null ast in astToString');
    switch (ast.kind) {
        case 'returnStatement':
            return `return ${astToString(ast.expression)}`;
        case 'ternary':
            return `${astToString(ast.condition)} ? ${astToString(ast.ifTrue)} : ${astToString(ast.ifFalse)}`;
        case 'equality':
            return `${astToString(ast.lhs)} == ${astToString(ast.rhs)}`;
        case 'identifier':
            return ast.value;
        case 'number':
            return ast.value.toString();
        case 'callExpression':
            const args = join(ast.arguments.map(astToString), ', ');
            return `${ast.name}(${args})`;
        case 'functionLiteral':
            return ast.deanonymizedName;
        case 'product':
            return `${astToString(ast.lhs)} * ${astToString(ast.rhs)}`;
        case 'addition':
            return `${astToString(ast.lhs)} + ${astToString(ast.rhs)}`;
        case 'subtraction':
            return `${astToString(ast.lhs)} - ${astToString(ast.rhs)}`;
        case 'stringLiteral':
            return `"${ast.value}"`;
        case 'booleanLiteral':
            return ast.value ? 'True' : 'False';
        case 'concatenation':
            return `${ast.lhs} ++ ${ast.rhs}`;
        case 'typedDeclarationAssignment':
            return `${ast.destination}: ${ast.type.name} = ${astToString(ast.expression)};`;
        case 'reassignment':
            return `${ast.destination} = ${astToString(ast.expression)};`;
        default:
            throw debug(`${(ast as any).kind} unhandled in astToString`);
    }
};

const typeErrorToString = (e: TypeError): string => JSON.stringify(e, null, 2);

export const compileAndRun = async (
    t,
    {
        source,
        expectedExitCode,
        expectedTypeErrors,
        expectedParseErrors,
        expectedStdOut = '',
        expectedAst,
        printSubsteps = [],
        debugSubsteps = [],
        failing = [],
        vizAst = false,
    }: CompileAndRunOptions
) => {
    if (typeof printSubsteps === 'string') {
        printSubsteps = [printSubsteps];
    }
    if (typeof debugSubsteps === 'string') {
        debugSubsteps = [debugSubsteps];
    }
    if (typeof failing === 'string') {
        failing = [failing];
    }
    const printableSubsteps = ['js', 'tokens', 'ast', 'c', 'mips', 'structure'];
    printSubsteps.forEach(substepToPrint => {
        if (!printSubsteps.includes(substepToPrint)) {
            t.fail(`${substepToPrint} is not a printable substep`);
        }
    });

    // Make sure it parses
    const lexResult = lex(tokenSpecs, source);
    lexResult.forEach(({ string, type }) => {
        if (type === 'invalid') {
            t.fail(`Unable to lex. Invalid token: ${string}`);
        }
    });

    if (printSubsteps.includes('tokens')) {
        console.log(JSON.stringify(lexResult, null, 2));
    }

    const parseResult = parseMpl(lexResult);
    if (printSubsteps.includes('ast')) {
        console.log(JSON.stringify(parseResult, null, 2));
    }

    if (vizAst) {
        const parseResult = stripResultIndexes(parse(grammar, 'program', lexResult, 0));
        if (parseResultIsError(parseResult)) {
            t.fail(`Bad parse result. Found: ${parseResult.found}. Expected: ${parseResult.expected}`);
            return;
        }
        const dotFile = await tmpFile({ postfix: '.dot' });
        const svgFile = await tmpFile({ postfix: '.svg' });
        await writeFile(dotFile.fd, dot.write(toDotFile(parseResult)));
        await exec(`dot -Tsvg -o${svgFile.path} ${dotFile.path}`);
        await open(svgFile.path, { app: 'Google Chrome' });
    }

    // Frontend
    if (expectedAst) {
        t.deepEqual(stripSourceLocation(parseResult), expectedAst);
    }
    const frontendOutput = compile(source);
    if (expectedParseErrors && 'parseErrors' in frontendOutput) {
        t.deepEqual(expectedParseErrors, frontendOutput.parseErrors);
        return;
    } else if ('parseErrors' in frontendOutput) {
        t.fail(
            `Found parse errors when none expected: ${join(frontendOutput.parseErrors.map(parseErrorToString), ', ')}`
        );
        return;
    } else if (expectedParseErrors) {
        t.fail('Expected parse errors and none found');
        return;
    }

    if (expectedTypeErrors && 'typeErrors' in frontendOutput) {
        t.deepEqual(expectedTypeErrors, frontendOutput.typeErrors);
        return;
    } else if ('typeErrors' in frontendOutput) {
        t.fail(`Found type errors when none expected: ${join(frontendOutput.typeErrors.map(typeErrorToString), ', ')}`);
        return;
    } else if (expectedTypeErrors) {
        t.fail('Expected type errors and none found');
        return;
    }

    // Run valdations on frontend output (currently just detects values that don't match their type)
    frontendOutput.functions.forEach(f => {
        f.variables.forEach(v => {
            if (!v.type.name) {
                t.fail(`Invalid frontend output: ${v.name} (in ${f.name}) had a bad type!`);
            }
        });
    });

    const printStructure = printSubsteps.includes('structure') ? console.log.bind(console) : () => {};
    const structure = frontendOutput as BackendInputs;
    printStructure('Functions:');
    structure.functions.forEach(f => {
        printStructure(`-> ${f.name}(${join(f.parameters.map(p => p.type.name), ', ')})`);
        f.statements.forEach(statement => {
            printStructure(`---> `, astToString(statement));
        });
    });
    printStructure('Program:');
    printStructure('-> Globals:');
    structure.globalDeclarations.forEach(declaration => {
        printStructure(`---> ${declaration.type.name} ${declaration.name} (${declaration.location})`);
    });
    printStructure('-> Statements:');
    structure.program.statements.forEach(statement => {
        printStructure(`---> `, astToString(statement));
    });

    // Backends
    const backends: Backend[] = [jsBackend, cBackend, mipsBackend, x64Backend];
    for (let i = 0; i < backends.length; i++) {
        const backend = backends[i];
        if (!failing.includes(backend.name)) {
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
            if ('error' in result) {
                t.fail(`${backend.name} execution failed: ${result.error}`);
                return;
            }

            if (result.exitCode !== expectedExitCode || result.stdout !== expectedStdOut) {
                const errorMessage = `${backend.name} had unexpected output.
Exit code: ${result.exitCode}. Expected: ${expectedExitCode}.
Stdout: "${result.stdout}".
Expected: "${expectedStdOut}"`;
                t.fail(errorMessage);
            }
        }
    }

    t.pass();
};
