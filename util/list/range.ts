export default (lower: number, upper: number) =>
    // @ts-ignore
    Array.from({ length: upper - lower }, (v, k) => k + lower);
