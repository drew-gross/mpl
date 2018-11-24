import idMaker from './idMaker.js';

export default () => {
    const makeId = idMaker();
    return (name: string): string => {
        return `${name}_${makeId()}`;
    };
};
