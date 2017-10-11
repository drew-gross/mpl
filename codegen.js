const toMips = require('./backends/mips.js');
const toJS = require('./backends/js.js');
import toC from './backends/c.js';

export { toJS };
export { toC };
export { toMips };
