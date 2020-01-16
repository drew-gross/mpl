import debug from '../../util/debug';
// Remove items from array, starting at the front, processing them with fn, until array is empty. fn may add new items to array.
export default <T>(array: T[], fn: (a: T) => void) => {
    while (array.length > 0) {
        const item = array.shift();
        if (!item) throw debug('item violation');
        fn(item);
    }
};
