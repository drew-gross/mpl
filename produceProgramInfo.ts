import { tokenSpecs, MplToken, grammar } from './grammar.js';
import { lex, Token } from './parser-lib/lex.js';

type ProgramInfo = {
    lexResult: Token<MplToken>[];
};

export default (program: string): ProgramInfo | string => {
    const lexResult = lex(tokenSpecs, program);

    lexResult.forEach(({ string, type }) => {
        if (type === 'invalid') {
            return `Unable to lex. Invalid token: ${string}`;
        }
    });
    return { lexResult };
};
