import * as Ast from './ast.js';
import debug from './util/debug.js';
import { VariableDeclaration, BackendInputs, ExecutionResult, Function, StringLiteralData } from './api.js';
import flatten from './util/list/flatten.js';
import {
    RegisterTransferLanguageExpression,
    RegisterTransferLanguageFunction as RTLF,
} from './backends/registerTransferLanguage.js';

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

export type Register =
    | 'functionArgument1'
    | 'functionArgument2'
    | 'functionArgument3'
    | 'functionResult'
    | { name: string };

export const registerToString = (r: Register): string => {
    if (typeof r == 'string') {
        return r;
    }
    return r.name;
};

export type BackendOptions = {
    ast: Ast.Ast;
    destination: Register;
    globalDeclarations: VariableDeclaration[];
    stringLiterals: StringLiteralData[];
    variablesInScope: { [key: string]: Register };
    makeTemporary: (name: string) => Register;
    makeLabel: (name: string) => string;
};

export const stringLiteralName = ({ id, value }: StringLiteralData) =>
    `string_literal_${id}_${value.replace(/[^a-zA-Z]/g, '')}`;

export type RegisterAssignment = { [key: string]: Register };

export const saveRegistersCode = (registerAssignment: RegisterAssignment): RegisterTransferLanguageExpression[] =>
    Object.values(registerAssignment).map(targetRegister => ({
        kind: 'push' as 'push',
        register: targetRegister,
        why: 'Push register to preserve it',
    }));

export const restoreRegistersCode = (registerAssignment: RegisterAssignment): RegisterTransferLanguageExpression[] =>
    Object.values(registerAssignment)
        .map(targetRegister => ({
            kind: 'pop' as 'pop',
            register: targetRegister,
            why: 'Restore preserved registers',
        }))
        .reverse();

export const assignRegisters = (rtlf: RTLF): RegisterAssignment => {
    throw debug('TODO: implement assignRegisters');
};
