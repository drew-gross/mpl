const path = require('path');

module.exports = env => {
    const useDevLoader = env !== undefined && 'experimental' in env && env.experimental === true;
    const loader = useDevLoader
        ? path.resolve('built/mpl-loader-dev')
        : path.resolve('built/mpl-loader');
    console.log(loader);
    console.log('loader');

    return {
        devtool: 'inline-source-map',
        entry: {
            mpl: './mpl.ts',
            'mpl-loader': './mpl-loader.ts',
        },
        output: {
            path: path.join(__dirname, 'tools'),
            filename: '[name]',
            library: 'mplLoader',
            libraryExport: 'loaderasdasd',
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
