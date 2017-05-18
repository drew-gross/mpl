const { alternative, sequence, terminal } = require('./parser-combinator.js');

const toC = ast => {
    console.log(ast);
    if (ast.type == 'number') {
        return `int main(int argc, char **argv) { return ${ast.children[0].value}; }`;
    } else if (ast.type == 'sum') {
        const lhs = ast.children[0].children[0].value;
        const rhs = ast.children[1].children[0].value;
        return `int main(int argc, char **argv) { return ${lhs} + ${rhs}; }`;
    }
};

const toJS = ast => {
    if (ast.type == 'number') {
        return `process.exit(${ast.children[0].value});`;
    } else if (ast.type == 'sum') {
        const lhs = ast.children[0].children[0].value;
        const rhs = ast.children[1].children[0].value;
        return `process.exit(${lhs} + ${rhs});`;
    }
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

const parseProduct1 = sequence('product', [
    terminal('number'),
    terminal('product'),
    (t, i) => parseExpression(t, i),
]);
const parseProduct2 = sequence('product', [
    terminal('leftBracket'),
    (t, i) => parseExpression(t, i),
    terminal('product'),
    (t, i) => parseExpression(t, i),
    terminal('rightBracket'),
]);
const parseProduct = alternative('product', [parseProduct1, parseProduct2]);

const parseExpression1 = parseProduct;
const parseExpression2 = sequence('expression', [
    terminal('leftBracket'),
    (t, i) => parseExpression(t, i),
    terminal('rightBracket'),
]);
const parseExpression3 = terminal('number');

const parseExpression = alternative('expression', [parseExpression1, parseExpression2, parseExpression3]);

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
