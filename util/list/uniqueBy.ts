export default <T>(p: ((T) => any), array: T[]): T[] => {
    const result: T[] = [];
    for (const item of array) {
        if (result.every(existing => p(existing) !== p(item))) {
            result.push(item);
        }
    }
    return result;
};
