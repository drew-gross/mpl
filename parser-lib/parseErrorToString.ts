import ParseError from './ParseError';
import join from '../util/join';

export default ({ expected, found, sourceLocation, whileParsing }: ParseError): string => {
    const line = sourceLocation.line;
    const col = sourceLocation.column;
    return `Expected ${expected} but found ${found} at ${line}:${col} (${join(whileParsing, "->")})`;
};
