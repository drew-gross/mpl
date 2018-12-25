import { tokenSpecs, MplToken, MplAst, grammar } from './grammar.js';
import { lex, Token } from './parser-lib/lex.js';
import { parseMpl, parseErrorToString } from './frontend.js';
import { parse, stripResultIndexes, toDotFile, parseResultIsError, stripSourceLocation } from './parser-lib/parse.js';

type ProgramInfo = {
    tokens: Token<MplToken>[];
    ast: MplAst;
};

export default (program: string): ProgramInfo | string => {
    const tokens = lex(tokenSpecs, program);

    tokens.forEach(({ string, type }) => {
        if (type === 'invalid') {
            return `Unable to lex. Invalid token: ${string}`;
        }
    });

    const ast = parseMpl(tokens);
    if (Array.isArray(ast)) {
        return `Bad parse result: ${ast.map(parseErrorToString)}`;
    }

    return { tokens, ast };
};
