import { tokenSpecs, MplToken, MplAst, grammar } from './grammar.js';
import { lex, Token } from './parser-lib/lex.js';
import { parseMpl, compile, parseErrorToString, FrontendOutput } from './frontend.js';
import { parse, stripResultIndexes, toDotFile, parseResultIsError, stripSourceLocation } from './parser-lib/parse.js';

type ProgramInfo = {
    tokens: Token<MplToken>[];
    ast: MplAst;
    frontendOutput: FrontendOutput;
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

    return { tokens, ast, frontendOutput };
};
