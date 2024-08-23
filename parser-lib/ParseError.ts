import SourceLocation from './sourceLocation';

type ParseError = {
    expected: string;
    found: string;
    sourceLocation: SourceLocation;
};
export default ParseError;
