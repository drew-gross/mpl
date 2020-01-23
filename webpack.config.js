const path = require('path');

module.exports = env => {
    const useDevLoader = env !== undefined && 'experimental' in env && env.experimental === true;
    const loader = useDevLoader
        ? path.resolve('tools/mpl-loader-dev')
        : path.resolve('tools/mpl-loader');
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
                    use: loader,
                },
            ],
        },
        resolve: {
            extensions: ['.tsx', '.ts', '.js', '.mpl'],
        },
        target: 'node',
    };
};
