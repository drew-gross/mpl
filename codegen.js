const flatten = require('./util/list/flatten.js');
const toMips = require('./backends/mips.js');
const toJS = require('./backends/js.js');
const toC = require('./backends/c.js');

module.exports = { toJS, toC, toMips };
