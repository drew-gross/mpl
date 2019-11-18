import debug from '../util/debug.js';
import SourceLocation from './sourceLocation.js';

export type TokenSpec<TokenType> = {
    token: string;
    type: TokenType;
    action?: (x: string) => string | number | null;
    toString: (x: any) => string;
};

export type Token<TokenType> = {
    type: TokenType;
    string: string;
    value?: string | number | null;
    sourceLocation: SourceLocation;
};

export type LexError = {
    kind: 'lexError';
    error: string;
};

export const lex = <TokenType>(
    tokenSpecs: TokenSpec<TokenType>[],
    input: string
): Token<TokenType>[] | LexError => {
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
    const tokens: Token<TokenType>[] = [];
    while (input.length > 0) {
        // This results in runnng match twice. Once to find if there is a match, and once to extract it. TODO: optimize!
        const matchingSpec = tokenSpecs.find(
            spec => !!input.match(RegExp(`^(${spec.token})[ \\t\\n]*`))
        );
        if (!matchingSpec) {
            return { kind: 'lexError', error: `Invalid token: ${input}` };
        } else {
            // TOOO don't allow a single "word" to be parsed as 2 token.
            const match = input.match(RegExp(`^(${matchingSpec.token})[ \\t\\n]*`));
            if (!match) throw debug('Should have failed earlier.');
            input = input.slice(match[0].length);
            const action = matchingSpec.action || (() => null);
            const value = action(match[1]);
            tokens.push({
                type: matchingSpec.type,
                value,
                string: matchingSpec.toString(value),
                sourceLocation: { line: currentSourceLine, column: currentSourceColumn },
            });
            updateSourceLocation(match[0]);
        }
    }
    return tokens;
};
