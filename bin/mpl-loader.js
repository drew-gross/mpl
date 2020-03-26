const rawLoader = require('./mpl-loader-raw.js');

module.exports = function (source) {
    return rawLoader.mplLoader(source, this);
};
