export default <T>(array: T[][]): T[] => array.reduce((a: T[], b: T[]) => a.concat(b), []);
