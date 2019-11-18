export default (lower: number, upper: number) =>
    Array.from({ length: upper - lower }, (v, k) => k + lower);
