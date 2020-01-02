import { parseProgram as parseTacProgram } from './threeAddressCode/parser.js';
import {
    mallocWithSbrk,
    printWithPrintRuntimeFunction,
    readIntDirect,
} from './threeAddressCode/runtime.js';
import { tokenSpecs, MplToken, MplAst } from './grammar.js';
import writeTempFile from './util/writeTempFile.js';
import { lex, Token, LexError } from './parser-lib/lex.js';
import { parseMpl, compile } from './frontend.js';
import { FrontendOutput, ExecutionResult, CompilationResult } from './api.js';
import ParseError from './parser-lib/ParseError.js';
import join from './util/join.js';
import { toString as typeToString } from './types.js';
import { astToString } from './ast.js';
import { Program, toString as programToString } from './threeAddressCode/Program.js';
import { makeTargetProgram } from './threeAddressCode/generator.js';
import { backends } from './backend-utils.js';

type BackendResult = {
    name: string;
    compilationResult: CompilationResult;
    executionResults: ExecutionResult[];
};

type ProgramInfo = {
    tokens: Token<MplToken>[];
    ast: MplAst;
    threeAddressCode: string;
    threeAddressRoundTrip: Program | LexError | ParseError[];
    frontendOutput: FrontendOutput;
    backendResults: BackendResult[];
    structure: string;
};

type RequestedInfo = {
    includeExecutionResult: boolean;
    skipBackends?: string[];
};

export default async (
    source: string,
    stdin: string,
    { includeExecutionResult, skipBackends }: RequestedInfo
): Promise<
    ProgramInfo | LexError | { parseErrors: ParseError[] } | { typeErrors: TypeError[] }
> => {
    const tokens = lex(tokenSpecs, source);
    if ('kind' in tokens) {
        return tokens;
    }

    const ast = parseMpl(tokens);
    if (Array.isArray(ast)) {
        return { parseErrors: ast };
    }

    const frontendOutput = compile(source);

    if (
        'parseErrors' in frontendOutput ||
        'typeErrors' in frontendOutput ||
        'kind' in frontendOutput ||
        'internalError' in frontendOutput
    ) {
        return frontendOutput as any;
    }

    let structure = '';
    structure += 'Functions:\n';
    frontendOutput.functions.forEach(f => {
        structure += `-> ${f.name}(${join(
            f.parameters.map(p => typeToString(p.type)),
            ', '
        )})\n`;
        f.statements.forEach(statement => {
            structure += `---> ${astToString(statement)}\n`;
        });
    });
    structure += 'Program:\n';
    structure += '-> Globals:\n';
    frontendOutput.globalDeclarations.forEach(declaration => {
        structure += `---> ${declaration.type.kind} ${declaration.name}\n`;
    });
    structure += '-> Statements:\n';
    frontendOutput.program.statements.forEach(statement => {
        structure += `---> ${astToString(statement)}\n`;
    });

    // Make three address code with random alignment, bytesInWord, and malloc/print impl. TODO: This is jank. Maybe three addree code should abstract over platform stuff?
    const threeAddressCode = makeTargetProgram({
        backendInputs: frontendOutput,
        targetInfo: {
            bytesInWord: 4,
            syscallNumbers: {},
            functionImpls: {
                mallocImpl: mallocWithSbrk(7),
                printImpl: printWithPrintRuntimeFunction(11),
                readIntImpl: readIntDirect(5),
            },
        },
    });

    // Do a roundtrip on three address code to string and back to check the parser for that
    const stringForm = programToString(threeAddressCode);
    const roundTripParsed = parseTacProgram(stringForm);

    const stdinFile = await writeTempFile(stdin, 'stdin', 'txt');

    const backendResults: BackendResult[] = await Promise.all(
        backends.map(async ({ name, compile: compileFn, executors }) => {
            const compilationResult = await compileFn(frontendOutput);

            // TODO: better way to report these specific errors. Probably muck with the type of ExecutionResult.
            if ('error' in compilationResult) {
                return {
                    name,
                    compilationResult,
                    executionResults: [{ error: 'Compilation failed', executorName: 'N/A' }],
                };
            } else if (!includeExecutionResult || (skipBackends || []).includes(name)) {
                return {
                    name,
                    compilationResult,
                    executionResults: [{ error: 'Not requested', executorName: 'N/A' }],
                };
            } else {
                const executionResults = await Promise.all(
                    executors.map(
                        async ({ execute }) =>
                            await execute(compilationResult.binaryFile.path, stdinFile.path)
                    )
                );
                return { name, compilationResult, executionResults };
            }
        })
    );

    return {
        tokens,
        ast,
        frontendOutput,
        structure,
        threeAddressCode: stringForm,
        threeAddressRoundTrip: roundTripParsed as any,
        backendResults,
    };
};
