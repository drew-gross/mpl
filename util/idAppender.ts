import idMaker from './idMaker';

export default () => {
    const idMakers = {};
    return (name: string): string => {
        if (name in idMakers) {
            return `${name}_${idMakers[name]()}`;
        }
        idMakers[name] = idMaker();
        return `${name}_`; // TODO: Remove the underscore and figure out why test fail
    };
};
