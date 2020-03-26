const path = require('path');

module.exports = env => {
    let filename = '[name]-experimental.js';
    if (env.commit) {
        filename = '[name].js';
    } else if (env.experimental) {
        filename = '[name]-super-experimental.js';
    }

    return {
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
                    use: {
                        loader: './bin/mpl-loader.js',
                        options: { experimental: env.experimental },
                    },
                    exclude: /node_modules/,
                },
            ],
        },
        resolve: { extensions: ['.ts', '.js'] },
        output: {
            filename,
            path: path.resolve(__dirname, 'bin'),
            library: 'mplLoader',
            libraryTarget: 'umd',
        },
    };
};
