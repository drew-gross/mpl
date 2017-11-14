import { AstNode } from './parser-combinator.js'; // TODO: This shouldn't be necessary

export type Type = {
    name: 'String' | 'Integer' | 'Boolean'
} | {
    name: 'Function',
    arg: { type: Type },
};
export type MemoryCategory = 'GlobalStatic' | 'Dynamic' | 'Stack';
export type VariableDeclaration = {
    name: string,
    type: Type,
    memoryCategory: MemoryCategory,
};
export type IdentifierDict = { [name: string]: Type }; // TODO: Don't export this (or rethink it)
export type Function = {
    name: string,
    statements: AstNode[],
    variables: VariableDeclaration[],
    argument: any,
    temporaryCount: number,
    knownIdentifiers: IdentifierDict,
};
export type BackendInputs = {
    functions: Function[],
    program: Function,
    globalDeclarations: VariableDeclaration[],
    stringLiterals,
};
export type Backend = {
    toExectuable: (BackendInputs) => string,
    name: string,
    execute: (string) => Promise<number | string>, // Exit code or error
}
