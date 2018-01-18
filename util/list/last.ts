export default <T>(array: T[]): T | null => {
    if (array.length == 0) {
        return null;
    } else {
        return array[array.length - 1];
    }
};
