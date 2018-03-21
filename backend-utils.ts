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

export const astToRtl = (ast: BackendOptions): RegisterTransferLanguageExpression[] => {
    throw debug();
};
