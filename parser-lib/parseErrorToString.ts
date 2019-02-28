import ParseError from './ParseError.js';
import join from '../util/join.js';

export default ({ expected, found, sourceLocation }: ParseError): string => {
    const line = sourceLocation.line;
    const col = sourceLocation.column;
    return `Expected ${expected} but found ${found} at ${line}:${col}`;
};
