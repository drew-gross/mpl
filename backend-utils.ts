import * as Ast from './ast.js';
import debug from './util/debug.js';
import { VariableDeclaration, BackendInputs, ExecutionResult, Function, StringLiteralData } from './api.js';
import flatten from './util/list/flatten.js';
import { RegisterTransferLanguageExpression } from './backends/registerTransferLanguage.js';

export type CompiledExpression<T> = {
    prepare: T[];
    execute: T[];
    cleanup: T[];
};

export type CompiledAssignment<T> = {
    prepare: T[];
    execute: T[];
    cleanup: T[];
};

export type CompiledProgram<T> = {
    prepare: T[];
    execute: T[];
    cleanup: T[];
};

type ExpressionCompiler<T> = (expressions: T[][]) => T[];
export const compileExpression = <T>(
    subExpressions: CompiledExpression<T>[],
    expressionCompiler: ExpressionCompiler<T>
): CompiledExpression<T> => ({
    prepare: flatten(subExpressions.map(input => input.prepare)),
    execute: expressionCompiler(subExpressions.map(input => input.execute)),
    cleanup: flatten(subExpressions.reverse().map(input => input.cleanup)),
});

///////////// Assembly spcecific utils. TODO: Move these to Register Tranfer Langauge utils //////////

// TODO: Replace with register transfer langauge
export type StorageSpec =
    | { type: 'register'; destination: string }
    | { type: 'memory'; spOffset: number }
    | 'functionArgument1'
    | 'functionArgument2'
    | 'functionArgument3'
    | 'functionResult';
export type RegisterAssignment = { [index: string]: StorageSpec };

export const storageSpecToString = (spec: StorageSpec): string => {
    if (typeof spec == 'string') {
        return spec;
    }
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

export const stringLiteralName = ({ id, value }: StringLiteralData) =>
    `string_literal_${id}_${value.replace(/[^a-zA-Z]/g, '')}`;

export const saveRegistersCode = (
    firstRegister,
    nextRegister,
    numRegisters: number
): RegisterTransferLanguageExpression[] => {
    let result: RegisterTransferLanguageExpression[] = [];
    let currentRegister: StorageSpec = firstRegister;
    while (numRegisters > 0) {
        result.push({
            kind: 'push',
            register: currentRegister,
            why: 'Save registers we intend to use',
        });
        currentRegister = nextRegister(currentRegister);
        numRegisters--;
    }
    return result;
};

export const restoreRegistersCode = (
    firstRegister,
    nextRegister,
    numRegisters: number
): RegisterTransferLanguageExpression[] => {
    let result: RegisterTransferLanguageExpression[] = [];
    let currentRegister: StorageSpec = firstRegister;
    while (numRegisters > 0) {
        result.push({
            kind: 'pop',
            register: currentRegister,
            why: 'Restore registers that we used',
        });
        currentRegister = nextRegister(currentRegister);
        numRegisters--;
    }
    return result.reverse();
};
