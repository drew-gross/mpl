import debug from './debug.js';
import deepcopy from 'deepcopy';
// Binary search tree based set structure. No balancing. Iterations is ordered lowest to highest. TODO: use red-black tree.

enum ComparisonResult {
    LT = -1,
    EQ = 0,
    GT = 1,
}

type SetComparator<T> = (lhs: T, rhs: T) => ComparisonResult;

// TODO: These are duplcited from set.ts. DRY up.
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

// All items in lower side are lower. All items in higher side are higher.
type TreeNode<T> = {
    lower: TreeNode<T> | null;
    higher: TreeNode<T> | null;
    parent: TreeNode<T> | null;
    data: T;
};

export const orderedSet = <T>(cmp: SetComparator<T>): OrderedSet<T> => {
    let head: TreeNode<T> | null = null;
    const forEach = (f: SetForEachPredicate<T>, node: TreeNode<T>) => {
        // See https://www.geeksforgeeks.org/inorder-non-threaded-binary-tree-traversal-without-recursion-or-stack/
        let current: TreeNode<T> = node;
        let lowerDone = false;
        while (true) {
            // Get to the lowest item of this tree that we haven't done.
            if (!lowerDone) {
                while (current.lower) {
                    current = current.lower;
                }
            }

            // Iterate it.
            f(current.data);

            // We have done this item and everything left of it.
            lowerDone = true;

            if (current.higher) {
                // If there are higher items, iterate them.
                current = current.higher;
                lowerDone = false;
            } else if (current.parent) {
                // Iterate back up the tree until we find an item we are lower than.
                while (current.parent && current.parent.higher == current) {
                    current = current.parent;
                }
                // We have done that item and it's subtree. Next do it's parent and parent's higher items..
                if (current.parent) {
                    current = current.parent;
                } else {
                    return;
                }
            } else {
                // No higher or parent nodes, implies current is root and lower-leaning and we are done
                if (current !== head || current.higher) debug('expected state');
                return;
            }
        }
    };
    return {
        add: (item: T) => {
            if (head == null) {
                head = {
                    lower: null,
                    higher: null,
                    parent: null,
                    data: item,
                };
                return;
            }
            let current = head;
            while (true) {
                switch (cmp(item, current.data)) {
                    case ComparisonResult.LT:
                        if (current.lower == null) {
                            current.lower = {
                                lower: null,
                                higher: null,
                                parent: current,
                                data: item,
                            };
                            return;
                        } else {
                            current = current.lower;
                        }
                        break;
                    case ComparisonResult.GT:
                        if (current.higher == null) {
                            current.higher = {
                                lower: null,
                                higher: null,
                                parent: current,
                                data: item,
                            };
                            return;
                        } else {
                            current = current.higher;
                        }
                        break;
                    case ComparisonResult.EQ:
                        // Don't add, item is alread in set
                        return;
                }
            }
        },
        copy: () => deepcopy(head),
        removeWithPredicate: (predicate: (item: T) => boolean): void => {
            throw debug('not implemented');
        },
        size: () => {
            throw debug('not im lemented');
        },
        toList: () => {
            const out: T[] = [];
            if (head) forEach(x => out.push(x), head);
            return out;
        },
        forEach: (f: SetForEachPredicate<T>) => {
            if (head) forEach(f, head);
        },
        remove: (item: Exclude<T, object | []>) => {
            throw debug('not im lemented');
        },
    };
};
