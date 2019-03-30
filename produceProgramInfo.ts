import debug from './util/debug.js';
import { parseProgram as parseTacProgram } from './threeAddressCode/parser.js';
import { programToString } from './threeAddressCode/programToString.js';
import { mallocWithSbrk, printWithPrintRuntimeFunction, readIntDirect } from './threeAddressCode/runtime.js';
import { tokenSpecs, MplToken, MplAst, grammar } from './grammar.js';
import writeTempFile from './util/writeTempFile.js';
import { writeFile } from 'fs-extra';
import { lex, Token, LexError } from './parser-lib/lex.js';
import { parseMpl, compile } from './frontend.js';
import { parse, stripResultIndexes, toDotFile, parseResultIsError, stripSourceLocation } from './parser-lib/parse.js';
import { FrontendOutput, ExecutionResult, CompilationResult } from './api.js';
import ParseError from './parser-lib/ParseError.js';
import join from './util/join.js';
import { toString as typeToString } from './types.js';
import { astToString } from './ast.js';
import { ThreeAddressProgram } from './threeAddressCode/generator.js';
import { makeTargetProgram } from './threeAddressCode/generator.js';
import { backends } from './backend-utils.js';

type BackendResult = {
    name: string;
    compilationResult: CompilationResult;
    executionResult: ExecutionResult;
};

type ProgramInfo = {
    tokens: Token<MplToken>[];
    ast: MplAst;
    threeAddressRoundTrip: ThreeAddressProgram | LexError | ParseError[];
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
): Promise<ProgramInfo | LexError | { parseErrors: ParseError[] } | { typeErrors: TypeError[] }> => {
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
        structure += `-> ${f.name}(${join(f.parameters.map(p => typeToString(p.type)), ', ')})\n`;
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
            alignment: 17,
            bytesInWord: 13,
            cleanupCode: [],
            mallocImpl: mallocWithSbrk(7),
            printImpl: printWithPrintRuntimeFunction(11),
            readIntImpl: readIntDirect(5),
        },
    });

    // Do a roundtrip on three address code to string and back to check the parser for that
    const stringForm = programToString(threeAddressCode);
    const roundTripParsed = parseTacProgram(stringForm);

    const stdinFile = await writeTempFile(stdin, '.txt');

    const backendResults = await Promise.all(
        backends.map(async ({ name, compile, execute }) => {
            const compilationResult = await compile(frontendOutput);
            const result = { name, compilationResult };

            if ('error' in compilationResult) {
                return { name, compilationResult, executionResult: { error: 'Compilation failed' } };
            } else if (!includeExecutionResult || (skipBackends || []).includes(name)) {
                return { name, compilationResult, executionResult: { error: 'Not requested' } };
            } else {
                const executionResult = await execute(compilationResult.binaryFile.path, stdinFile.path);
                return { name, compilationResult, executionResult };
            }
        })
    );

    return { tokens, ast, frontendOutput, structure, threeAddressRoundTrip: roundTripParsed as any, backendResults };
};
