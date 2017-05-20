const { alternative, sequence, terminal } = require('./parser-combinator.js');

const astToC = ast => {
    switch (ast.type) {
        case 'program': return [...astToC(ast.children[1]), `return stack[0];`];
        case 'number': return [`stack[stackSize] = ${ast.value}; stackSize++;`];
        case 'product1': return [
            ...astToC(ast.children[0]),
            ...astToC(ast.children[2]),
            `{
                char tmp1 = stack[stackSize - 1]; stackSize--;
                char tmp2 = stack[stackSize - 1]; stackSize--;
                stack[stackSize] = tmp1 + tmp2; stackSize++;
            }`
        ];
        case 'expression':
            debugger;
            return;
    };
};

const toC = ast => {
    let C = astToC(ast);

    return `
#include <stdio.h>

int main(int argc, char **argv) {
    char stack[255];
    char stackSize = 0;
    ${C.join('\n')}
}
`;
};

const astToJS = ast => {
    switch (ast.type) {
        case 'program': return [...astToJS(ast.children[1]), `process.exit(stack[0]);`];
        case 'number': return [`stack.push(${ast.value});`];
        case 'product1': return [
            ...astToJS(ast.children[0]),
            ...astToJS(ast.children[2]),
            `{ let tmp1 = stack.pop(); let tmp2 = stack.pop(); stack.push(tmp1 * tmp2); }`,
        ];
    }
};

const toJS = ast => {
    let JS = astToJS(ast);
    return `
let stack = [];
${JS.join('\n')}
`;
};

const lex = input => {

    const tokenSpecs = [{
        token: 'return',
        type: 'return',
    }, {
        token: '\\d+',
        type: 'number',
        action: parseInt,
    }, {
        token: '\\+',
        type: 'sum',
    }, {
        token: '\\*',
        type: 'product',
    }, {
        token: '\\(',
        type: 'leftBracket',
    }, {
        token: '\\)',
        type: 'rightBracket',
    }, {
        token: '.*',
        type: 'invalid',
        action: x => x,
    }];

    // slurp initial whitespace
    input = input.trim();

    // consume input reading tokens
    let tokens = [];
    while (input.length > 0) {
        for (const tokenSpec of tokenSpecs) {
            const match = input.match(RegExp(`^(${tokenSpec.token})\\s*`));
            if (!match) continue;
            input = input.slice(match[0].length);
            const action = tokenSpec.action || (() => null);
            tokens.push({ type: tokenSpec.type, value: action(match[1])});
            break;
        }
    }
    return tokens;
};

// Grammar:
// PROGRAM -> return EXPRESSION
// EXPRESSION -> PRODUCT | ( EXPRESSION ) | int
// PRODUCT -> int * EXPRESSION | ( EXPRESSION * EXPRESSION )

const parseProduct1 = sequence('product1', [
    terminal('number'),
    terminal('product'),
    (t, i) => parseExpression(t, i),
]);
const parseProduct2 = sequence('product2', [
    terminal('leftBracket'),
    (t, i) => parseExpression(t, i),
    terminal('product'),
    (t, i) => parseExpression(t, i),
    terminal('rightBracket'),
]);
const parseProduct = alternative([parseProduct1, parseProduct2]);

const parseExpression1 = parseProduct;
const parseExpression2 = sequence('bracketedExpression', [
    terminal('leftBracket'),
    (t, i) => parseExpression(t, i),
    terminal('rightBracket'),
]);
const parseExpression3 = terminal('number');

const parseExpression = alternative([parseExpression1, parseExpression2, parseExpression3]);

const parseProgram = sequence('program', [
    terminal('return'),
    parseExpression
]);

const flattenAst = ast => {
    if (ast.children) {
        return { type: ast.type, children: ast.children.map(flattenAst) };
    } else {
        return {
            type: ast.type,
            value: ast.value,
        };
    }
}

const parse = tokens => {
    const resultTree = parseProgram(tokens, 0)
    if (resultTree.success === false) {
        return {};
    }
    const flattenedTree = flattenAst(resultTree);
    return flattenedTree;
};

const compile = ({ source, target }) => {
    let tokens = lex(source);
    ast = parse(tokens);
    if (target == 'js') {
        return toJS(ast);
    } else if (target == 'c') {
        return toC(ast);
    }
};

module.exports = { parse, lex, compile };
