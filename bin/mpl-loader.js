const loaderUtils = require('loader-utils');
module.exports = function (source) {
    const options = loaderUtils.getOptions(this);
    const rawLoader = options.experimental
        ? require('./mpl-loader-raw-experimental.js')
        : require('./mpl-loader-raw.js');
    return rawLoader.mplLoader(source, this);
};
