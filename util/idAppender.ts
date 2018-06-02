export default () => {
    let id = 0;
    return (name: string): string => {
        id++;
        return `${name}_${id}`;
    };
};
