import { tokenSpecs, MplToken, MplAst, grammar } from './grammar.js';
import { lex, Token } from './parser-lib/lex.js';
import { parseMpl, compile, parseErrorToString, FrontendOutput } from './frontend.js';
import { parse, stripResultIndexes, toDotFile, parseResultIsError, stripSourceLocation } from './parser-lib/parse.js';
import { BackendInputs } from './api.js';
import join from './util/join.js';
import { toString as typeToString } from './types.js';
import { astToString } from './ast.js';

type ProgramInfo = {
    tokens: Token<MplToken>[];
    ast: MplAst;
    frontendOutput: FrontendOutput;
    structure: string;
};

export default (source: string): ProgramInfo | string => {
    const tokens = lex(tokenSpecs, source);

    tokens.forEach(({ string, type }) => {
        if (type === 'invalid') {
            return `Unable to lex. Invalid token: ${string}`;
        }
    });

    const ast = parseMpl(tokens);
    if (Array.isArray(ast)) {
        return `Bad parse result: ${ast.map(parseErrorToString)}`;
    }

    const frontendOutput = compile(source);

    let structureText = '';
    const structure = frontendOutput as BackendInputs;
    structureText += 'Functions:\n';
    structure.functions.forEach(f => {
        structureText += `-> ${f.name}(${join(f.parameters.map(p => typeToString(p.type)), ', ')})\n`;
        f.statements.forEach(statement => {
            structureText += `---> ${astToString(statement)}\n`;
        });
    });
    structureText += 'Program:\n';
    structureText += '-> Globals:\n';
    structure.globalDeclarations.forEach(declaration => {
        structureText += `---> ${declaration.type.kind} ${declaration.name}\n`;
    });
    structureText += '-> Statements:\n';
    structure.program.statements.forEach(statement => {
        structureText += `---> ${astToString(statement)}\n`;
    });

    return { tokens, ast, frontendOutput, structure: structureText };
};
