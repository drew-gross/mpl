import ComparisonResult from './util/comparisonResult.js';
import compareString from './string/compare.js';

export type Register = { name: string };
export const isEqual = (lhs: Register, rhs: Register): boolean => lhs.name == rhs.name;
export const compare = (lhs: Register, rhs: Register): ComparisonResult => compareString(lhs.name, rhs.name);
export const toString = (r: Register): string => `r:${r.name}`;
