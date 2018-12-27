import { tokenSpecs, MplToken, MplAst, grammar } from './grammar.js';
import { lex, Token, LexError } from './parser-lib/lex.js';
import { parseMpl, compile, parseErrorToString } from './frontend.js';
import { parse, stripResultIndexes, toDotFile, parseResultIsError, stripSourceLocation } from './parser-lib/parse.js';
import { FrontendOutput, ParseError } from './api.js';
import join from './util/join.js';
import { toString as typeToString } from './types.js';
import { astToString } from './ast.js';

type ProgramInfo = {
    tokens: Token<MplToken>[];
    ast: MplAst;
    frontendOutput: FrontendOutput;
    structure: string;
};

export default (
    source: string
): ProgramInfo | LexError | { parseErrors: ParseError[] } | { typeErrors: TypeError[] } => {
    const tokens = lex(tokenSpecs, source);
    if ('kind' in tokens) {
        return tokens;
    }

    tokens.forEach(({ string, type }) => {
        if (type === 'invalid') {
            return `Unable to lex. Invalid token: ${string}`;
        }
    });

    const ast = parseMpl(tokens);
    if (Array.isArray(ast)) {
        return { parseErrors: ast };
    }

    const frontendOutput = compile(source);

    if ('parseErrors' in frontendOutput || 'typeErrors' in frontendOutput) {
        return frontendOutput as any;
    }

    let structureText = '';
    structureText += 'Functions:\n';
    frontendOutput.functions.forEach(f => {
        structureText += `-> ${f.name}(${join(f.parameters.map(p => typeToString(p.type)), ', ')})\n`;
        f.statements.forEach(statement => {
            structureText += `---> ${astToString(statement)}\n`;
        });
    });
    structureText += 'Program:\n';
    structureText += '-> Globals:\n';
    frontendOutput.globalDeclarations.forEach(declaration => {
        structureText += `---> ${declaration.type.kind} ${declaration.name}\n`;
    });
    structureText += '-> Statements:\n';
    frontendOutput.program.statements.forEach(statement => {
        structureText += `---> ${astToString(statement)}\n`;
    });

    return { tokens, ast, frontendOutput, structure: structureText };
};
