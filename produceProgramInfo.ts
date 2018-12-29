import { parseProgram as parseTacProgram } from './threeAddressCode/parser.js';
import { programToString } from './threeAddressCode/programToString.js';
import { mallocWithSbrk, printWithPrintRuntimeFunction } from './threeAddressCode/runtime.js';
import { tokenSpecs, MplToken, MplAst, grammar } from './grammar.js';
import { file as tmpFile } from 'tmp-promise';
import { writeFile } from 'fs-extra';
import { lex, Token, LexError } from './parser-lib/lex.js';
import { parseMpl, compile, parseErrorToString } from './frontend.js';
import { parse, stripResultIndexes, toDotFile, parseResultIsError, stripSourceLocation } from './parser-lib/parse.js';
import { FrontendOutput, ParseError, ExecutionResult } from './api.js';
import join from './util/join.js';
import { toString as typeToString } from './types.js';
import { astToString } from './ast.js';
import { ThreeAddressProgram } from './threeAddressCode/generator.js';
import { makeTargetProgram } from './threeAddressCode/generator.js';
import { backends } from './backend-utils.js';

type BackendResult = {
    name: string;
    targetSource: string;
    executionResult: ExecutionResult;
};

type ProgramInfo = {
    tokens: Token<MplToken>[];
    ast: MplAst;
    threeAddressCode: {
        parsed: ThreeAddressProgram;
        asString: string;
        roundTripParsed: ThreeAddressProgram | LexError | ParseError[];
    };
    frontendOutput: FrontendOutput;
    backendResults: BackendResult[];
    structure: string;
};

export default async (
    source: string
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

    if ('parseErrors' in frontendOutput || 'typeErrors' in frontendOutput) {
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
        },
    });

    // Do a roundtrip on three address code to string and back to check the parser for that
    const stringForm = programToString(threeAddressCode);
    const roundTripParsed = parseTacProgram(stringForm);

    const backendResults = await Promise.all(
        backends.map(async ({ name, mplToExectuable, execute }) => {
            const targetSource = mplToExectuable(frontendOutput);

            const exeFile = await tmpFile({ postfix: `.${name}` });
            await writeFile(exeFile.fd, targetSource);
            const executionResult = await execute(exeFile.path);

            return { name, targetSource, executionResult };
        })
    );

    return {
        tokens,
        ast,
        frontendOutput,
        structure,
        threeAddressCode: {
            parsed: threeAddressCode,
            asString: stringForm,
            roundTripParsed: roundTripParsed as any,
        },
        backendResults,
    };
};
