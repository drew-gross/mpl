import debug from './debug.js';
// Binary search tree based set structure. No balancing. TODO: use red-black tree.

// TODO: These are duplcited from set.ts. DRY up.
type SetComparator<T> = (lhs: T, rhs: T) => boolean;
type SetForEachPredicate<T> = (item: T) => void;

export type OrderedSet<T> = {
    add: (item: T) => void;

    remove: (item: T) => void;
    removeWithPredicate: (predicate: (item: T) => boolean) => void;

    size: () => number;

    copy: () => OrderedSet<T>;

    toList: () => T[];
    forEach: (f: SetForEachPredicate<T>) => void;
};

type TreeNode<T> = {
    left: TreeNode<T>;
    right: TreeNode<T>;
    data: T;
} | null;

export const orderedSet = <T>(lessThan: SetComparator<T>): OrderedSet<T> => {
    let head: TreeNode<T> = null;
    return {
        add: (item: T) => {
            if (head == null) {
                head = {
                    left: null,
                    right: null,
                    data: item,
                };
                return;
            }
            let tmpHead = head;
            while (true) {
                if (lessThan(item, tmpHead.data)) {
                    if (tmpHead.left == null) {
                        tmpHead.left = {
                            left: null,
                            right: null,
                            data: item,
                        };
                    } else {
                        tmpHead = tmpHead.left;
                    }
                } else if (lessThan(tmpHead.data, item)) {
                    if (tmpHead.right == null) {
                        tmpHead.right = {
                            left: null,
                            right: null,
                            data: item,
                        };
                    } else {
                        tmpHead = tmpHead.right;
                    }
                } else {
                    // items are the same, don't add
                    return;
                }
            }
        },
        copy: () => {
            throw debug('not implemented');
        },
        removeWithPredicate: (predicate: (item: T) => boolean): void => {
            throw debug('not implemented');
        },
        size: () => {
            throw debug('not im lemented');
        },
        toList: () => {
            throw debug('not im lemented');
        },
        forEach: (f: SetForEachPredicate<T>) => {
            throw debug('not im lemented');
        },
        remove: item => {
            throw debug('not im lemented');
        },
    };
};
