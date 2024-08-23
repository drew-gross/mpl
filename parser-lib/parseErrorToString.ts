import ParseError from './ParseError';

export default ({ expected, found, sourceLocation }: ParseError): string => {
    const line = sourceLocation.line;
    const col = sourceLocation.column;
    return `Expected ${expected} but found ${found} at ${line}:${col}`;
};
