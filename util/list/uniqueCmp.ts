export default <T>(p: (x: T, y: T) => boolean, array: T[]): T[] => {
    const result: T[] = [];
    for (const item of array) {
        if (result.every(existing => !p(item, existing))) {
            result.push(item);
        }
    }
    return result;
};
