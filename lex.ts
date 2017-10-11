type TokenSpec = {
    token: string,
    type: string,
    action?: (x: string) => any,
    toString: (x: any) => string,
};

export default input => {
    const tokenSpecs: TokenSpec[] = [{
        token: 'return',
        type: 'return',
        toString: () => 'return',
    }, {
        token: 'true|false',
        type: 'booleanLiteral',
        action: x => x.trim(),
        toString: x => x,
    }, {
        token: '[a-z]\\w*',
        type: 'identifier',
        action: x => x,
        toString: x => x,
    }, {
        token: 'Integer|Boolean|Function',
        type: 'type',
        action: x => x,
        toString: x => x,
    }, {
        token: ';|\\n',
        type: 'statementSeparator',
        toString: _ => '\n',
    }, {
        token: '=>',
        type: 'fatArrow',
        toString: _ => '=>',
    }, {
        token: '==',
        type: 'equality',
        toString: _ => '==',
    }, {
        token: '=',
        type: 'assignment',
        toString: _ => '=',
    }, {
        token: '\\d+',
        type: 'number',
        action: parseInt,
        toString: x => x.toString(),
    }, {
        token: '\\+',
        type: 'sum',
        toString: _ => '+',
    }, {
        token: '\\*',
        type: 'product',
        toString: _ => '*',
    }, {
        token: '\\-',
        type: 'subtraction',
        toString: _ => '-',
    }, {
        token: '\\(',
        type: 'leftBracket',
        toString: _ => '(',
    }, {
        token: '\\)',
        type: 'rightBracket',
        toString: _ => ')',
    }, {
        token: '{',
        type: 'leftCurlyBrace',
        toString: _ => '{',
    }, {
        token: '}',
        type: 'rightCurlyBrace',
        toString: _ => '}',
    }, {
        token: '\\:',
        type: 'colon',
        toString: _ => ':',
    }, {
        token: '\\?',
        type: 'ternaryOperator',
        toString: _ => '?',
    }, {
        token: '.*',
        type: 'invalid',
        action: x => x,
        toString: x => x,
    }];

    // slurp initial whitespace
    if (!input) debugger;
    input = input.trim();

    // consume input reading tokens
    let tokens = [];
    while (input.length > 0) {
        for (const tokenSpec of tokenSpecs) {
            const match = input.match(RegExp(`^(${tokenSpec.token})[ \\t]*`));
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
