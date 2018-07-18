export default () => {
    let id = 0;
    return () => {
        id++;
        return id;
    };
};
