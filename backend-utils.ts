import { isEqual } from 'lodash';
import * as Ast from './ast.js';
import debug from './util/debug.js';
import { VariableDeclaration, BackendInputs, ExecutionResult, Function, StringLiteralData } from './api.js';
import flatten from './util/list/flatten.js';

type PureRegisterTransferLanguageExpression =
    | { kind: 'move'; from: string; to: string }
    | { kind: 'loadImmediate'; value: number; destination: StorageSpec };

// TODO: get rid of string!
export type RegisterTransferLanguageExpression = string | { why: string } & PureRegisterTransferLanguageExpression;

export type CompiledExpression = {
    prepare: RegisterTransferLanguageExpression[];
    execute: RegisterTransferLanguageExpression[];
    cleanup: RegisterTransferLanguageExpression[];
};

export type CompiledAssignment = {
    prepare: RegisterTransferLanguageExpression[];
    execute: RegisterTransferLanguageExpression[];
    cleanup: RegisterTransferLanguageExpression[];
};

export type CompiledProgram = {
    prepare: RegisterTransferLanguageExpression[];
    execute: RegisterTransferLanguageExpression[];
    cleanup: RegisterTransferLanguageExpression[];
};

type ExpressionCompiler = (expressions: RegisterTransferLanguageExpression[][]) => RegisterTransferLanguageExpression[];
export const compileExpression = (
    subExpressions: CompiledExpression[],
    expressionCompiler: ExpressionCompiler
): CompiledExpression => ({
    prepare: flatten(subExpressions.map(input => input.prepare)),
    execute: expressionCompiler(subExpressions.map(input => input.execute)),
    cleanup: flatten(subExpressions.reverse().map(input => input.cleanup)),
});

///////////// Assembly spcecific utils. TODO: Move these to Register Tranfer Langauge utils //////////

// TODO: Replace with register transfer langauge
export type StorageSpec = { type: 'register'; destination: string } | { type: 'memory'; spOffset: number };
export type RegisterAssignment = { [index: string]: StorageSpec };

export const storageSpecToString = (spec: StorageSpec): string => {
    switch (spec.type) {
        case 'register':
            return spec.destination;
        case 'memory':
            return `$sp-${spec.spOffset}`;
    }
};

export type BackendOptions = {
    ast: Ast.Ast;
    registerAssignment: RegisterAssignment;
    destination: StorageSpec;
    currentTemporary: StorageSpec;
    globalDeclarations: VariableDeclaration[];
    stringLiterals: StringLiteralData[];
};

export const astToRegisterTransferLanguage = (input: BackendOptions, nextTemporary): CompiledExpression => {
    const { ast, registerAssignment, destination, currentTemporary, globalDeclarations, stringLiterals } = input;
    if (isEqual(currentTemporary, destination)) throw debug(); // Sanity check to make sure caller remembered to provide a new temporary
    const recurse = newInput => astToRegisterTransferLanguage({ ...input, ...newInput }, nextTemporary);
    switch (ast.kind) {
        case 'number':
            return compileExpression([], ([]) => [
                { kind: 'loadImmediate', value: ast.value, destination: destination, why: '' },
            ]);
        case 'returnStatement':
            const subExpression = recurse({
                ast: ast.expression,
                destination: currentTemporary,
                currentTemporary: nextTemporary(currentTemporary),
            });
            return compileExpression([subExpression], ([e1]) => [
                `; evaluate expression of return statement, put in ${(currentTemporary as any).destination}`,
                ...e1,
                { kind: 'move', from: (currentTemporary as any).destination, to: 'rax', why: 'rax is function result' },
            ]);
        default:
            throw debug();
    }
};
