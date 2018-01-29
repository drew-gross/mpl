import debug from './util/debug.js';

type TokenType =
    | 'return'
    | 'booleanLiteral'
    | 'stringLiteral'
    | 'identifier'
    | 'type'
    | 'statementSeparator'
    | 'fatArrow'
    | 'equality'
    | 'assignment'
    | 'number'
    | 'sum'
    | 'product'
    | 'subtraction'
    | 'leftBracket'
    | 'rightBracket'
    | 'leftCurlyBrace'
    | 'rightCurlyBrace'
    | 'colon'
    | 'comma'
    | 'ternaryOperator'
    | 'endOfFile'
    | 'concatenation'
    | 'invalid';

type TokenSpec = {
    token: string;
    type: TokenType;
    action?: (x: string) => string | number | null;
    toString: (x: any) => string;
};

type Token = {
    type: TokenType;
    string: string;
    value?: string | number | null;
};

const lex = (input: string): Token[] => {
    const tokenSpecs: TokenSpec[] = [
        {
            token: '"[^"]*"',
            type: 'stringLiteral',
            action: x => {
                const trimmed = x.trim();
                const quotesRemoved = trimmed.substring(1, trimmed.length - 1);
                return quotesRemoved;
            },
            toString: x => x,
        },
        {
            token: 'return',
            type: 'return',
            toString: () => 'return',
        },
        {
            token: 'true|false',
            type: 'booleanLiteral',
            action: x => x.trim(),
            toString: x => x,
        },
        {
            token: '[a-z]\\w*',
            type: 'identifier',
            action: x => x,
            toString: x => x,
        },
        {
            token: '[A-Z][a-z]*',
            type: 'type',
            action: x => x,
            toString: x => x,
        },
        {
            token: ';',
            type: 'statementSeparator',
            toString: _ => ';\n',
        },
        {
            token: '=>',
            type: 'fatArrow',
            toString: _ => '=>',
        },
        {
            token: '==',
            type: 'equality',
            toString: _ => '==',
        },
        {
            token: '=',
            type: 'assignment',
            toString: _ => '=',
        },
        {
            token: '\\d+',
            type: 'number',
            action: parseInt,
            toString: x => x.toString(),
        },
        {
            token: '\\+\\+',
            type: 'concatenation',
            toString: _ => '++',
        },
        {
            token: '\\+',
            type: 'sum',
            toString: _ => '+',
        },
        {
            token: '\\*',
            type: 'product',
            toString: _ => '*',
        },
        {
            token: '\\-',
            type: 'subtraction',
            toString: _ => '-',
        },
        {
            token: '\\(',
            type: 'leftBracket',
            toString: _ => '(',
        },
        {
            token: '\\)',
            type: 'rightBracket',
            toString: _ => ')',
        },
        {
            token: '{',
            type: 'leftCurlyBrace',
            toString: _ => '{',
        },
        {
            token: '}',
            type: 'rightCurlyBrace',
            toString: _ => '}',
        },
        {
            token: '\\:',
            type: 'colon',
            toString: _ => ':',
        },
        {
            token: '\\?',
            type: 'ternaryOperator',
            toString: _ => '?',
        },
        {
            token: ',',
            type: 'comma',
            toString: _ => ',',
        },
        {
            token: '.*',
            type: 'invalid',
            action: x => x,
            toString: x => x,
        },
    ];

    // slurp initial whitespace
    if (!input) throw debug();
    input = input.trim();

    // consume input reading tokens
    let tokens: Token[] = [];
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

export { lex, Token, TokenType };
