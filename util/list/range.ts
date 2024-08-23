export default (lower: number, upper: number) =>
    Array.from({ length: upper - lower }, (_v, k) => k + lower);
