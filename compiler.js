module.exports = {
    parse: contents => ({
        statements: contents.split('\n').filter(line => line.length > 0),
    }),

    evaluate: ({ statements }) => {
        return parseInt(statements[statements.length - 1], 10);
    },

    toC: ({ statements }) => {
        return `int main(int arg, char **argv) { return ${parseInt(statements[statements.length - 1], 10)}; }`;
    },
}
