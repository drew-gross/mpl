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
    toDotFile: () => string;
};

// All items in lower side are lower. All items in higher side are higher.
type TreeNode<T> = {
    lower: TreeNode<T> | null;
    higher: TreeNode<T> | null;
    parent: TreeNode<T> | null;
    data: T;
};

// Look at each tree node with it's rank. Head has rank 0, it's children have rank 1, etc.
type SetForEachPredicateInternal<T> = (item: TreeNode<T>, rank: number) => void;

export const orderedSet = <T>(cmp: SetComparator<T>): OrderedSet<T> => {
    let head: TreeNode<T> | null = null;
    const forEachNode = (f: SetForEachPredicateInternal<T>, node: TreeNode<T>) => {
        // See https://www.geeksforgeeks.org/inorder-non-threaded-binary-tree-traversal-without-recursion-or-stack/
        let current: TreeNode<T> = node;
        let rank = 0;
        let lowerDone = false;
        while (true) {
            // Get to the lowest item of this tree that we haven't done.
            if (!lowerDone) {
                while (current.lower) {
                    current = current.lower;
                    rank++;
                }
            }

            // Iterate it.
            f(current, rank);

            // We have done this item and everything left of it.
            lowerDone = true;

            if (current.higher) {
                // If there are higher items, iterate them.
                current = current.higher;
                rank++;
                lowerDone = false;
            } else if (current.parent) {
                // Iterate back up the tree until we find an item we are lower than.
                while (current.parent && current.parent.higher == current) {
                    current = current.parent;
                    rank--;
                }
                if (!current.parent) {
                    return;
                }
                // Start iterating from the item we are lower than, with lowerDone still true.
                current = current.parent;
                rank--;
            } else {
                // No parent == at top, done higher == done all
                if (current !== head || current.higher) debug('expected state');
                return;
            }
        }
    };

    const remove = (item: T, node: TreeNode<T>) => {
        // Constant space w/tail recursion
        switch (cmp(item, node.data)) {
            case ComparisonResult.LT:
                if (node.lower) remove(item, node.lower);
                break;
            case ComparisonResult.GT:
                if (node.higher) remove(item, node.higher);
                break;
            case ComparisonResult.EQ:
                // See diagrams from https://www.techiedelight.com/deletion-from-bst/
                if (!node.lower && !node.higher) {
                    // Case #1
                    if (node.parent) {
                        if (node.parent.lower == node) {
                            node.parent.lower = null;
                        } else if (node.parent.higher == node) {
                            node.parent.higher = null;
                        } else {
                            debug('recursion broke');
                        }
                    } else {
                        if (head != node) {
                            debug('Something is horribly wrong');
                        }
                        head = null;
                    }
                } else if (!node.lower) {
                    // Case #3 (lower)
                    // Move actual node because identity needs to be same, we compare pointers in forEach.
                    // Replace ourselves in parent.
                    if (!node.higher) throw debug('Boole was wrong! /ts');
                    if (node.parent) {
                        if (node.parent.lower == node) {
                            node.parent.lower = node.higher;
                            node.higher.parent = node.parent;
                        } else {
                            node.parent.higher = node.higher;
                            node.higher.parent = node.parent;
                        }
                    } else {
                        head = node.higher;
                    }
                } else if (!node.higher) {
                    // Case #3, but for higher
                    if (node.parent) {
                        if (node.parent.lower == node) {
                            node.parent.lower = node.lower;
                            node.lower.parent = node.parent;
                        } else {
                            node.parent.higher = node.lower;
                            node.lower.parent = node.parent;
                        }
                    }
                } else {
                    // Case #2
                    // Arbitrarily copy up from higher subtree. TODO: choose left or right based on balancing
                    let leastUpperBound = node.higher;
                    while (leastUpperBound.lower) {
                        leastUpperBound = leastUpperBound.lower;
                    }
                    if (!leastUpperBound.parent) throw debug('magic happened');

                    // Detach least upper bound from it's parent. If least upper bound has children, make those the child of least upper bound's children. Only least upper bound can't have lower chilren, if it did they would be a lower upper bound.
                    let leastUpperBoundsChildren = leastUpperBound.higher;
                    if (leastUpperBoundsChildren) {
                        if (leastUpperBound.parent.higher == leastUpperBound) {
                            leastUpperBound.parent.lower = leastUpperBoundsChildren;
                            leastUpperBoundsChildren.parent = leastUpperBound.parent;
                        } else if (leastUpperBound.parent.lower == leastUpperBound) {
                            leastUpperBound.parent.lower = leastUpperBoundsChildren;
                            leastUpperBoundsChildren.parent = leastUpperBound.parent;
                        } else {
                            debug('wat');
                        }
                    }

                    // Reattach least upper bound replacing node
                    leastUpperBound.parent = node.parent;
                    leastUpperBound.lower = node.lower;
                    leastUpperBound.higher = node.higher;

                    // Patch children and parent to point at right place. Then node is fully detached
                    if (leastUpperBound.lower) {
                        leastUpperBound.lower.parent = leastUpperBound;
                    }
                    if (leastUpperBound.higher) {
                        leastUpperBound.higher.parent = leastUpperBound;
                    }
                    if (leastUpperBound.parent) {
                        if (leastUpperBound.parent.lower == node) {
                            leastUpperBound.parent.lower = leastUpperBound;
                        } else if (leastUpperBound.parent.higher == node) {
                            leastUpperBound.parent.higher = leastUpperBound;
                        } else {
                            throw debug('onoz');
                        }
                    }
                }
                break;
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
            if (head) forEachNode(x => out.push(x.data), head);
            return out;
        },
        forEach: (f: SetForEachPredicate<T>) => {
            if (head) forEachNode(n => f(n.data), head);
        },
        remove: (item: Exclude<T, object | []>) => {
            if (head) remove(item, head);
        },
        toDotFile: (): string => {
            let dotText = 'digraph {\n';

            // Map from node -> id number
            const idMap = new Map();
            // Map from rank -> node numbers at that rank
            const rankToIdsMap = new Map();
            // Rank by ID
            const idToRankMap = new Map();
            // Object to position map. Position = [order, rank]
            const objectToPositionMap = new Map();

            if (head) {
                // Give each node an ID
                let id = 0;
                forEachNode((x, rank) => {
                    idMap.set(x, id);
                    idToRankMap.set(id, rank);
                    if (!rankToIdsMap.has(rank)) {
                        rankToIdsMap.set(rank, [id]);
                    } else {
                        rankToIdsMap.get(rank).push(id);
                    }
                    objectToPositionMap.set(x, [id, rank]);
                    id++;
                }, head);

                // Add a node for each ID
                forEachNode(x => {
                    const label = JSON.stringify(x.data, null, 2).replace('"', '\\"');
                    const [xpos, ypos] = objectToPositionMap.get(x);
                    // xpos/ypos only used for neato and fdp layout engines. Doesn't look good though.
                    dotText += `node_${idMap.get(x)} [shape="box", label="${label}" pos="${xpos},${ypos}!"]\n`;
                }, head);

                // Add edges
                let nullId = 0;
                forEachNode(x => {
                    const includeParent = true; // Causes bad edge shapes
                    if (includeParent) {
                        if (x.parent) {
                            dotText += `node_${idMap.get(x)} -> node_${idMap.get(
                                x.parent
                            )} [constraint=false label="p"]\n`;
                        } else {
                            dotText += `null_${nullId} [shape="point"]\n`;
                            dotText += `node_${idMap.get(x)} -> null_${nullId} [constraint=false label="p"]\n`;
                            nullId++;
                        }
                    }
                    let lowerNode = '';
                    if (x.lower) {
                        lowerNode = `node_${idMap.get(x.lower)}`;
                        dotText += `node_${idMap.get(x)} -> ${lowerNode}\n`;
                    } else {
                        dotText += `null_${nullId} [shape="point"]\n`;
                        lowerNode = `null_${nullId}`;
                        dotText += `node_${idMap.get(x)} -> ${lowerNode}\n`;
                        nullId++;
                    }
                    let higherNode = '';
                    if (x.higher) {
                        higherNode = `node_${idMap.get(x.higher)}`;
                        dotText += `node_${idMap.get(x)} -> ${higherNode}\n`;
                    } else {
                        dotText += `null_${nullId} [shape="point"]\n`;
                        higherNode = `null_${nullId}`;
                        dotText += `node_${idMap.get(x)} -> ${higherNode}\n`;
                        nullId++;
                    }

                    // Add an invinisble egde from lower to higher to convince graphvis to put lower on the left
                    dotText += `${lowerNode} -> ${higherNode} [style="invis"]`;
                    dotText += `{rank=same; ${lowerNode}; ${higherNode};}`;
                }, head);

                // Add rank enforcement
                rankToIdsMap.forEach((ids, rank) => {
                    let rankText = '{rank=same;';
                    ids.forEach(nodeId => {
                        rankText += `node_${nodeId};`;
                    });
                    rankText += '}\n';
                    dotText += rankText;
                });
            }
            dotText += '}';
            return dotText;
        },
    };
};
