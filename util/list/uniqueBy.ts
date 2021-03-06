import uniqueCmp from './uniqueCmp';
export default <T>(p: (T) => any, array: T[]): T[] => uniqueCmp((x, y) => p(x) === p(y), array);
