import { Backend, BackendInputs } from './api.js';
import { UninferredAst } from './ast.js';
import { lex } from './lex.js';
import { parseMpl, compile } from './frontend.js';
import { file as tmpFile } from 'tmp-promise';
import { writeFile } from 'fs-extra';
import assertNever from './util/assertNever.js';
import debug from './util/debug.js';
import { tokenSpecs } from './grammar.js';

import mipsBackend from './backends/mips.js';
import jsBackend from './backends/js.js';
import cBackend from './backends/c.js';

type CompileAndRunOptions = {
    source: string;
    expectedExitCode: number;
    expectedTypeErrors: [any];
    expectedParseErrors: [any];
    expectedAst: [any];
    printSubsteps?: string[] | string;
    debugSubsteps?: string[] | string;
    failing?: string[] | string;
};

const astToString = (ast: UninferredAst) => {
    if (!ast) debug();
    switch (ast.kind) {
        case 'returnStatement':
            return `return ${astToString(ast.expression)}`;
        case 'ternary':
            return `${astToString(ast.condition)} ? ${astToString(ast.ifTrue)} : ${astToString(ast.ifFalse)}`;
        case 'stringEquality':
        case 'equality':
            return `${astToString(ast.lhs)} == ${astToString(ast.rhs)}`;
        case 'identifier':
            return ast.value;
        case 'number':
            return ast.value.toString();
        case 'typedAssignment':
            return `${ast.destination}: (TODO: put type here) = ${astToString(ast.expression)}`;
        case 'callExpression':
            return `${ast.name}(${astToString(ast.argument)})`;
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
        default:
            throw debug();
    }
};

export const compileAndRun = async (
    t,
    {
        source,
        expectedExitCode,
        expectedTypeErrors,
        expectedParseErrors,
        expectedAst,
        printSubsteps = [],
        debugSubsteps = [],
        failing = [],
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

    // Frontend
    if (expectedAst) {
        t.deepEqual(parseResult, expectedAst);
    }
    const frontendOutput = compile(source);
    if (expectedParseErrors && 'parseErrors' in frontendOutput) {
        t.deepEqual(expectedParseErrors, (frontendOutput as { parseErrors: string[] }).parseErrors);
        return;
    } else if ('parseErrors' in frontendOutput) {
        t.fail(
            `Found parse errors when none expected: ${(frontendOutput as {
                parseErrors: string[];
            }).parseErrors.join(', ')}`
        );
    } else if (expectedParseErrors) {
        t.fail('Expected parse errors and none found');
    }

    if (expectedTypeErrors && 'typeErrors' in frontendOutput) {
        t.deepEqual(expectedTypeErrors, (frontendOutput as { typeErrors: string[] }).typeErrors);
        return;
    } else if ('typeErrors' in frontendOutput) {
        t.fail(
            `Found type errors when none expected: ${(frontendOutput as {
                typeErrors: string[];
            }).typeErrors.join(', ')}`
        );
    } else if (expectedTypeErrors) {
        t.fail('Expected type errors and none found');
    }

    const fo = frontendOutput as BackendInputs;

    // Run valdations on frontend output (currently just detects values that don't match their type)
    fo.functions.forEach(f => {
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
        printStructure(`-> ${f.name}(${f.argument.type.name})`);
        f.statements.forEach(statement => {
            printStructure(`---> `, astToString(statement));
        });
    });
    printStructure('Program:');
    printStructure('-> Globals:');
    structure.globalDeclarations.forEach(declaration => {
        printStructure(`---> ${declaration.type.name} ${declaration.name} (${declaration.memoryCategory})`);
    });
    printStructure('-> Statements:');
    structure.program.statements.forEach(statement => {
        printStructure(`---> `, astToString(statement));
    });

    // Backends
    const backends: Backend[] = [jsBackend, cBackend, mipsBackend];
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
                t.fail(`${backend.name} execution failed: ${(result as any).error}`);
            }
            const result2 = result as any;

            if (result2.exitCode !== expectedExitCode) {
                const errorMessage = `${backend.name} had unexpected output.
Exit code: ${result2.exitCode}. Expected: ${expectedExitCode}.
Stdout: "${result2.stdout}".`;
                t.fail(errorMessage);
            }
        }
    }

    t.pass();
};
