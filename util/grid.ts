export default <T>(w: number, h: number, def: T): T[][] => {
    const result: T[][] = [];
    for (let i = 0; i < w; i++) {
        const newItem: T[] = [];
        for (let j = 0; j < h; j++) {
            newItem.push(def);
        }
        result.push(newItem);
    }
    return result;
};
