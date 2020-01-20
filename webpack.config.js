const path = require('path');

module.exports = {
    devtool: 'inline-source-map',
    entry: {
        mpl: './mpl.ts',
        'mpl-loader': './mpl-loader.ts',
    },
    module: {
        rules: [
            {
                exclude: /node_modules/,
                test: /\.tsx?$/,
                use: 'ts-loader',
            },
            {
                exclude: /node_modules/,
                test: /\.mpl$/,
                use: path.resolve('tools/mpl-loader'),
            },
        ],
    },
    resolve: {
        extensions: ['.tsx', '.ts', '.js'],
    },
    target: 'node',
};
