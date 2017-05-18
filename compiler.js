const { alternative, sequence, terminal } = require('./parser-combinator.js');

const astToStackOperationsC = ast => {
    switch (ast.type) {
        case 'program': return ast.children.map(astToStackOperationsC).reduce((a, b) => a.concat(b));
        case 'number': return [`stack[stackSize] = ${ast.value}; stackSize++;`];
        case 'product1': return [
            ...astToStackOperationsC(ast.children[0]),
            ...astToStackOperationsC(ast.children[2]),
            `{
                char tmp1 = stack[stackSize - 1]; stackSize--;
                char tmp2 = stack[stackSize - 1]; stackSize--;
                stack[stackSize] = tmp1 + tmp2; stackSize++;
            }`
        ]
    };
};

const toC = ast => {
    let stackOperations = astToStackOperationsC(ast);

    return `
#include <stdio.h>

int main(int argc, char **argv) {
    char stack[255];
    char stackSize = 0;
    ${stackOperations.join('\n')}
    if (stackSize == 1) {
        return stack[0];
    } else {
        printf("Error: stack did not end with size 1");
        return -1;
    }
}
`;
};

const astToStackOperationsJS = ast => {
    switch (ast.type) {
        case 'program': return ast.children.map(astToStackOperationsJS).reduce((a, b) => a.concat(b));
        case 'number': return [`stack.push(${ast.value});`];
        case 'product1': return [
            ...astToStackOperationsJS(ast.children[0]),
            ...astToStackOperationsJS(ast.children[2]),
            `{ let tmp1 = stack.pop(); let tmp2 = stack.pop(); stack.push(tmp1 * tmp2); }`,
        ];
    }
};

const toJS = ast => {
    let stackOperations = astToStackOperationsJS(ast);
    debugger;
    return `
let stack = [];
${stackOperations.join('\n')}
if (stack.length !== 1) {
    process.exit(-1);
}
process.exit(stack[0]);
`;
};

const lex = input => {
    let tokens = [];

    const tokenSpecs = [{
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
// PROGRAM -> EXPRESSION
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
const parseExpression2 = sequence('expression', [
    terminal('leftBracket'),
    (t, i) => parseExpression(t, i),
    terminal('rightBracket'),
]);
const parseExpression3 = terminal('number');

const parseExpression = alternative([parseExpression1, parseExpression2, parseExpression3]);

const parseProgram = (tokens, index) => {
    const productResult = parseExpression(tokens, index);
    if (!productResult.success) {
        return { success: false };
    }
    return {
        success: true,
        newIndex: productResult.newIndex,
        children: [productResult],
        type: 'program',
    };
}

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
