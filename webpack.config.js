const path = require('path');

module.exports = {
    entry: './mpl.ts',
    target: 'node',
    devtool: false,
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
        ],
    },
    resolve: { extensions: ['.ts', '.js'] },
    output: {
        filename: 'mpl.js',
        path: path.resolve(__dirname, 'bin'),
    },
};
