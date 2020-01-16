import idMaker from './idMaker';

export default () => {
    const makeId = idMaker();
    return (name: string): string => {
        return `${name}_${makeId()}`;
    };
};
