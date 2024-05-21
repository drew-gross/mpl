import SourceLocation from './sourceLocation';

type ParseError = {
    expected: string;
    found: string;
    sourceLocation: SourceLocation;
    whileParsing: string[];
};
export default ParseError;
