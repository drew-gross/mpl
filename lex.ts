import debug from './util/debug.js';

type TokenSpec<TokenType> = {
    token: string;
    type: TokenType;
    action?: (x: string) => string | number | null;
    toString: (x: any) => string;
};

type Token<TokenType> = {
    type: TokenType;
    string: string;
    value?: string | number | null;
};

const lex = <TokenType>(tokenSpecs: TokenSpec<TokenType>[], input: string): Token<TokenType>[] => {
    // slurp initial whitespace
    if (!input) throw debug();
    let currentSourceLine = 0;
    let currentSourceColumn = 0;
    const initialWhitespaceMatch = input.match(/^[ \t\n]*/);
    if (!initialWhitespaceMatch) throw debug();
    const initialWhitespace = initialWhitespaceMatch[0];
    input = input.slice(initialWhitespace.length);

    // consume input reading tokens
    let tokens: Token<TokenType>[] = [];
    while (input.length > 0) {
        for (const tokenSpec of tokenSpecs) {
            const match = input.match(RegExp(`^(${tokenSpec.token})[ \\t\\n]*`));
            if (!match) continue;
            input = input.slice(match[0].length);
            const action = tokenSpec.action || (() => null);
            const value = action(match[1]);
            tokens.push({
                type: tokenSpec.type,
                value,
                string: tokenSpec.toString(value),
            });
            break;
        }
    }
    return tokens;
};

export { lex, Token, TokenSpec };
