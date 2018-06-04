export type Set<T> = {
    add: (item: T) => void;
    addUnique: (item: T) => void;
    addSet: (other: Set<T>) => void;
    remove: (item: T) => void;

    size: () => number;

    has: (item: T) => boolean;
    copy: () => Set<T>;

    toList: () => T[];
    isSubsetOf: (other: Set<T>) => boolean;
    isEqual: (other: Set<T>) => boolean;
};

type SetComparator<T> = (lhs: T, rhs: T) => boolean;

export const set = <T>(isEqual: SetComparator<T>): Set<T> => {
    const data: T[] = [];
    const self = {
        // Add an item to the set if it is not equal to any existing items
        add: (item: T) => {
            if (data.every(existing => !isEqual(existing, item))) {
                data.push(item);
            }
        },
        // If you have external knowledge that the item is not already in the set,
        // you can add it unconditionally using this method
        addUnique: item => {
            data.push(item);
        },
        addSet: (newSet: Set<T>) => {
            newSet.toList().forEach(item => {
                self.add(item);
            });
        },
        remove: item => {
            const index = data.findIndex(existing => isEqual(item, existing));
            if (index != -1) {
                data.splice(index, 1);
            }
        },
        // Check if an item is in the set
        has: item => data.some(existing => isEqual(existing, item)),
        // Copy the set
        copy: () => {
            const copy = set(isEqual);
            data.forEach(item => copy.addUnique(item));
            return copy;
        },
        toList: () => data.slice(),
        // TODO: Type system should ban comparisons of sets with different isEqual
        isSubsetOf: (other: Set<T>) => {
            return data.every(item => other.has(item));
        },
        isEqual: (other: Set<T>) => {
            return self.isSubsetOf(other) && other.isSubsetOf(self);
        },
        size: () => data.length,
    };
    return self;
};

export const join = <T>(isEqual: SetComparator<T>, sets: Set<T>[]): Set<T> => {
    const result = set(isEqual);
    sets.forEach(newSet => {
        result.addSet(newSet);
    });
    return result;
};
