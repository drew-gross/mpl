const resolve = require('path').resolve;

module.exports = env => {
    let filename = '[name]-experimental.js';
    let path = resolve(__dirname, 'bin');
    if (env.commit) {
        filename = '[name].js';
    } else if (env.experimental) {
        filename = '[name]-super-experimental.js';
    } else if (env.tests) {
        filename = '[name].js';
        path = resolve(__dirname, 'built');
    }

    return {
        entry: {
            mpl: './mpl.ts',
            'mpl-loader-raw': './mpl-loader.ts',
            test: './test.ts',
            'debug-test-case': './debug-test-case.ts',
            benchmark: './benchmark.ts',
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
        output: { filename, path, library: 'mplLoader', libraryTarget: 'umd' },
        externals: { ava: 'ava', 'spawn-sync': 'spawn-sync' },
    };
};
