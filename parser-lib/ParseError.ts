import SourceLocation from './sourceLocation.js';

type ParseError = {
    expected: string;
    found: string;
    sourceLocation: SourceLocation;
};
export default ParseError;
