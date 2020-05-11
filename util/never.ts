import debug from './debug';
export default (n: never, f: string): never => {
    throw debug(`${JSON.stringify(n)} unhandled in ${f}`);
};
