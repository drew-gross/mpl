import ParseError from './ParseError';
import parseErrorToString from './parseErrorToString';
import annotateSource from '../annotateSource';

export default (e: ParseError, source: string): string | null => {
    // The semicolor the user forgot probably should go one space after where
    // the error is.
    const adjustedSourceLocation = { ...e.sourceLocation };
    adjustedSourceLocation.column += 1;
    return annotateSource(source, adjustedSourceLocation, parseErrorToString(e));
};
