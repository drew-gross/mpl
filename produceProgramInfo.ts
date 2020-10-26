import debug from './util/debug';
import { Type } from './types';
import { parseProgram as parseTacProgram } from './threeAddressCode/Program';
import {
    mallocWithSbrk,
    printWithPrintRuntimeFunction,
    readIntDirect,
} from './threeAddressCode/runtime';
import { tokenSpecs, MplToken, MplAst } from './grammar';
import writeTempFile from './util/writeTempFile';
import { lex, Token, LexError } from './parser-lib/lex';
import { parseMpl, compile } from './frontend';
import { FrontendOutput, ExecutionResult, CompilationResult } from './api';
import ParseError from './parser-lib/ParseError';
import join from './util/join';
import { toString as typeToString } from './types';
import { astToString } from './ast';
import { Program, toString as programToString } from './threeAddressCode/Program';
import { makeTargetProgram } from './threeAddressCode/generator';
import { backends } from './backend-utils';

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
    buildBinaries: boolean;
    skipBackends?: string[];
    skipExecutors?: string[];
};

export default async (
    source: string,
    stdin: string,
    { includeExecutionResult, skipBackends, skipExecutors, buildBinaries }: RequestedInfo
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
            f.parameters.map(p =>
                'namedType' in p.type ? p.type.namedType : typeToString(p.type)
            ),
            ', '
        )})\n`;
        f.statements.forEach(statement => {
            structure += `---> ${astToString(statement)}\n`;
        });
    });
    structure += 'Program:\n';
    structure += '-> Globals:\n';
    frontendOutput.globalDeclarations.forEach(declaration => {
        structure += `---> ${(declaration.type as Type).type.kind} ${declaration.name}\n`;
    });
    structure += '-> Statements:\n';
    if (Array.isArray(frontendOutput.program)) {
        throw debug("Produce Program Info doesn't support modules.");
    }
    frontendOutput.program.statements.forEach(statement => {
        structure += `---> ${astToString(statement)}\n`;
    });

    // Make three address code with random alignment, bytesInWord, and malloc/print impl. TODO: This is jank. Maybe three address code should abstract over platform stuff?
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

    let backendResults: BackendResult[] = [];
    if (buildBinaries) {
        backendResults = await Promise.all(
            backends.map(async ({ name, compile: compileFn, finishCompilation, executors }) => {
                const targetSource = await compileFn(frontendOutput);
                if ('error' in targetSource) {
                    return {
                        name,
                        compilationResult: targetSource,
                        executionResults: [{ error: 'Compilation Failed', executorName: 'N/A' }],
                    };
                }
                const compilationResult = await finishCompilation(
                    targetSource.target,
                    targetSource.tac
                );
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
                    const executionResults = (
                        await Promise.all(
                            executors.map(async ({ execute }) => {
                                if ((skipExecutors || []).includes(name)) {
                                    return;
                                }
                                return await execute(
                                    compilationResult.binaryFile.path,
                                    stdinFile.path
                                );
                            })
                        )
                    ).filter(Boolean) as any;
                    return { name, compilationResult, executionResults };
                }
            })
        );
    }

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
