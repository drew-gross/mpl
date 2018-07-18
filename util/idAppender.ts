import idMaker from './idMaker.js';

export default () => {
    let makeId = idMaker();
    return (name: string): string => {
        return `${name}_${makeId()}`;
    };
};
