const toC = tokens => {
    return `int main(int arg, char **argv) { return ${tokens[tokens.length - 1].value}; }`;
};

const toJS = tokens => {
    return `process.exit(${tokens[tokens.length - 1].value});`;
};

const lex = input => {
    let tokens = [];
    while (input.length > 0) {
        let match;
        if (match = input.match(/^(\d+)\s*/)) {
            input = input.slice(match[0].length);
            tokens.push({ type: 'number', value: parseInt(match[1]) });
        } else {
            tokens.push({ type: 'invalid', value: null });
            return tokens;
        }
    }
    return tokens;
};

const parse = contents => ({
    statements: contents.split('\n').filter(line => line.length > 0),
});

const compile = ({ source, target }) => {
    tokens = lex(source);
    if (target == 'js') {
        return toJS(tokens);
    } else if (target == 'c') {
        return toC(tokens);
    }
};

module.exports = {
    parse: parse,
    lex: lex,
    compile: compile,
}
