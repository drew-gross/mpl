const path = require('path');

module.exports = env => {
    const useDevLoader = env && 'experimental' in env && env.experimental === true;
    return {
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
                    use: useDevLoader
                        ? path.resolve('tools/mpl-loader')
                        : path.resolve('tools/mpl-loader-dev'),
                },
            ],
        },
        resolve: {
            extensions: ['.tsx', '.ts', '.js'],
        },
        target: 'node',
    };
};
