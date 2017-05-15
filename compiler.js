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

const parseTerminal = (terminal, tokens, index) => {
    if (tokens[index].type == terminal) {
        return {
            success: true,
            newIndex: index + 1,
            children: tokens[index],
            type: terminal,
        };
    }

    return { success: false };
}
const parseProduct1 = (tokens, index) => {
    if (tokens.length - index < 3) {
        return { success: false };
    }
    const intResult = parseTerminal('number', tokens, index);
    if (!intResult.success) {
        return { success: false };
    }

    const timesResult = parseTerminal('product', tokens, index + 1);
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
    const intResult = parseTerminal('number', tokens, index);
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


const parseProduct3 = (tokens, index) => {
    const lbResult = parseTerminal('leftBracket', tokens, index);
    if (!lbResult.success) {
        return { success: false };
    }

    const productResult = parseProduct(tokens, lbResult.newIndex);
    if (!productResult.success) {
        return { success: false };
    }

    const rbResult = parseTerminal('rightBracket', tokens, productResult.newIndex);
    if (!rbResult.success) {
        return { success: false };
    }

    return {
        success: true,
        newIndex: rbResult.newIndex,
        children: [lbResult.children, productResult.children, rbResult.children],
        type: 'product',
    };
}

const parseProduct = (tokens, index) => {
    const p1Result = parseProduct1(tokens, index);
    if (p1Result.success) {
        return p1Result;
    }

    const p2Result = parseProduct2(tokens, index);
    if (p2Result.success) {
        return p2Result;
    }

    const p3Result = parseProduct3(tokens, index);
    if (p3Result.success) {
        return p3Result;
    }

    return { success: false };
}

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

module.exports = {
    parse: parse,
    lex: lex,
    compile: compile,
}
