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
    while (input.length > 0) {
        let match;
        if (match = input.match(/^(\d+)\s*/)) {
            input = input.slice(match[0].length);
            tokens.push({ type: 'number', value: parseInt(match[1]) });
        } else if (match = input.match(/^(\+)\s*/)) {
            input = input.slice(match[0].length);
            tokens.push({ type: 'add', value: null });
        } else {
            tokens.push({ type: 'invalid', value: null });
            return tokens;
        }
    }
    return tokens;
};

// Grammar:
// PROGRAM = NUMBER | SUM
// SUM = NUMBER + NUMBER
// NUMBER = \d+

const parseSum = tokens => {
    if (tokens.length == 3 && tokens[0].type == 'number' && tokens[1].type == 'add' && tokens[2].type == 'number') {
        return {
            type: 'sum',
            children: [
                { type: 'number', children: [tokens[0]] },
                { type: 'number', children: [tokens[2]] },
            ],
        };
    }
    return null;
};

const parse = tokens => {
    let parseResult;
    if (parseResult = parseSum(tokens)) {
        return parseResult;
    } else if (tokens.length == 1 && tokens[0].type == 'number') {
        return { type: 'number', children: [tokens[0]] };
    }
    return null;
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
