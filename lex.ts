import debug from './util/debug.js';
import { SourceLocation } from './api.js';

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
    sourceLocation: SourceLocation;
};

const lex = <TokenType>(tokenSpecs: TokenSpec<TokenType>[], input: string): Token<TokenType>[] => {
    // Source location tracking
    let currentSourceLine = 1;
    let currentSourceColumn = 1;
    const updateSourceLocation = (matchString: string) => {
        for (const char of matchString) {
            if (char == '\n') {
                currentSourceLine++;
                currentSourceColumn = 1;
            } else {
                currentSourceColumn++;
            }
        }
    };

    // slurp initial whitespace
    const initialWhitespaceMatch = input.match(/^[ \t\n]*/);
    if (!initialWhitespaceMatch) throw debug('Initial whitespace didnt match in lex');
    const initialWhitespace = initialWhitespaceMatch[0];
    updateSourceLocation(initialWhitespace);

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
                sourceLocation: { line: currentSourceLine, column: currentSourceColumn },
            });
            updateSourceLocation(match[0]);
            break;
        }
    }
    return tokens;
};

export { lex, Token, TokenSpec };
