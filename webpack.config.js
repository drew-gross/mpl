const path = require('path');

module.exports = {
    entry: {
        mpl: './mpl.ts',
        'mpl-loader-raw': './mpl-loader.ts',
    },
    target: 'node',
    devtool: false,
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
            {
                test: /\.mpl$/,
                use: './bin/mpl-loader.js',
                exclude: /node_modules/,
            },
        ],
    },
    resolve: { extensions: ['.ts', '.js'] },
    output: {
        filename: '[name].js',
        path: path.resolve(__dirname, 'bin'),
        library: 'mplLoader',
        libraryTarget: 'umd',
    },
};
