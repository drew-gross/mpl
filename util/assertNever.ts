export default (x: never): never => {
    throw new Error(`Unexpected object: ${x}`);
}
