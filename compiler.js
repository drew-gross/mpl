const { alternative, sequence, terminal } = require('./parser-combinator.js');

const toC = ast => {
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
// PROGRAM -> PRODUCT
// PRODUCT -> int * PRODUCT | int | ( PRODUCT )

const parseProduct1 = (tokens, index) => {
    if (tokens.length - index < 3) {
        return { success: false };
    }
    const intResult = terminal('number')(tokens, index);
    if (!intResult.success) {
        return { success: false };
    }

    const timesResult = terminal('product')(tokens, index + 1);
    if (!timesResult.success) {
        return { success: false };
    }

    const productResult = parseProduct(tokens, index + 2);
    if (!productResult.success) {
        return { success: false };
    }

    return {
        success: true,
        newIndex: index + 3,
        children: [intResult.children, timesResult.children, productResult.children] ,
        type: 'product',
    };
}

const parseProduct2 = (tokens, index) => {
    const intResult = terminal('number')(tokens, index);
    if (!intResult.success) {
        return { success: false };
    }

    return {
        success: true,
        newIndex: intResult.newIndex,
        children: [intResult.children],
        type: 'product',
    };
}

const parseProduct3 = sequence([
    terminal('leftBracket'),
    (t, i) => parseProduct(t, i),
    terminal('rightBracket'),
]);

const parseProduct = alternative([parseProduct1, parseProduct2, parseProduct3]);

const parseProgram = (tokens, index) => {
    const productResult = parseProduct(tokens, index);
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
        return ast;
    }
}

const parse = tokens => {
    const resultTree = parseProgram(tokens, 0)
    return flattenAst(resultTree);
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
