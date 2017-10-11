export default <T>(array: T[]): T[] => [...new Set(array)];
