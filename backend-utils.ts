import * as Ast from './ast.js';
import debug from './util/debug.js';
import { VariableDeclaration, BackendInputs, ExecutionResult, Function, StringLiteralData } from './api.js';
import flatten from './util/list/flatten.js';
import { ThreeAddressStatement } from './backends/threeAddressCode.js';
import { Register } from './register.js';

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

export type BackendOptions = {
    ast: Ast.Ast;
    registerAssignment: RegisterAssignment;
    destination: Register;
    currentTemporary: Register;
    globalDeclarations: VariableDeclaration[];
    stringLiterals: StringLiteralData[];
};

export const stringLiteralName = ({ id, value }: StringLiteralData) =>
    `string_literal_${id}_${value.replace(/[^a-zA-Z]/g, '')}`;

export type RegisterAssignment = { [key: string]: Register };

export const saveRegistersCode = (firstRegister, nextRegister, numRegisters: number): ThreeAddressStatement[] => {
    let result: ThreeAddressStatement[] = [];
    let currentRegister: Register = firstRegister;
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

export const restoreRegistersCode = (firstRegister, nextRegister, numRegisters: number): ThreeAddressStatement[] => {
    let result: ThreeAddressStatement[] = [];
    let currentRegister: Register = firstRegister;
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
