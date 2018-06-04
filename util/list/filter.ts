interface Array<T> {
    filter<U extends T>(pred: (a: T) => a is U): U[];
}

export type FilterPredicate<T, U extends T> = (a: T) => a is U;

export const filter = <T, U extends T>(array: T[], predicate: FilterPredicate<T, U>): U[] => array.filter(predicate);
