module.exports = input => {
    const tokenSpecs = [{
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
        toString: () => '\n',
    }, {
        token: '=>',
        type: 'fatArrow',
        toString: () => '=>',
    }, {
        token: '==',
        type: 'equality',
        toString: () => '==',
    }, {
        token: '=',
        type: 'assignment',
        toString: () => '=',
    }, {
        token: '\\d+',
        type: 'number',
        action: parseInt,
        toString: x => x.toString(),
    }, {
        token: '\\+',
        type: 'sum',
        toString: () => '+',
    }, {
        token: '\\*',
        type: 'product',
        toString: () => '*',
    }, {
        token: '\\-',
        type: 'subtraction',
        toString: () => '-',
    }, {
        token: '\\(',
        type: 'leftBracket',
        toString: () => '(',
    }, {
        token: '\\)',
        type: 'rightBracket',
        toString: () => ')',
    }, {
        token: '{',
        type: 'leftCurlyBrace',
        toString: () => '{',
    }, {
        token: '}',
        type: 'rightCurlyBrace',
        toString: () => '}',
    }, {
        token: '\\:',
        type: 'colon',
        toString: () => ':',
    }, {
        token: '\\?',
        type: 'ternaryOperator',
        toString: () => '?',
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
