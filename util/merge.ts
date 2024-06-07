import debug from './debug';

export const mergeNoConflict = <V>(into: Map<string, V>, from: Map<string, V>) => {
    for (const [key, value] of from.entries()) {
        if (into.has(key)) throw debug(`map merge conflict: ${key}`);
        into.set(key, value);
    }
};
