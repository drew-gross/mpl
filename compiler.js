module.exports = {
    parse: contents => ({
        statements: contents.split('\n').filter(line => line.length > 0),
    }),

    lex: input => {
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
    },

    evaluate: ({ statements }) => {
        return parseInt(statements[statements.length - 1], 10);
    },

    toC: ({ statements }) => {
        return `int main(int arg, char **argv) { return ${parseInt(statements[statements.length - 1], 10)}; }`;
    },

    toJS: ({ statements }) => {
        return `process.exit(${parseInt(statements[statements.length - 1], 10)});`;
    },
}
