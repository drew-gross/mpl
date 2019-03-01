import SourceLocation from './parser-lib/sourceLocation.js';
import join from './util/join.js';

// Return a pretty representation of the source with the source location highlighted.
// Subject to change. Returns null if you provide bad input (e.g. source location
// outside of provided source)
export default (source: string, { line, column }: SourceLocation, message: string): string | null => {
    const lines = source.split('\n');
    if (line <= 0 || line >= lines.length + 1) return null;
    const contextBefore = lines[line - 2];
    const contextAfter = lines[line];
    const mainLine = lines[line - 1];
    if (column <= 0) return null;
    const pointerLine = ' '.repeat(column - 1) + `^ ${message}`;
    return join([contextBefore, mainLine, pointerLine, contextAfter].filter(l => l !== undefined), '\n');
};
