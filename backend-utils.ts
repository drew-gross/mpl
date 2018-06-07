import * as Ast from './ast.js';
import debug from './util/debug.js';
import { VariableDeclaration, BackendInputs, ExecutionResult, Function, StringLiteralData } from './api.js';
import flatten from './util/list/flatten.js';
import { ThreeAddressStatement, TargetThreeAddressStatement } from './backends/threeAddressCode.js';
import { Register } from './register.js';
import { controlFlowGraph } from './controlFlowGraph.js';

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
    destination: Register;
    globalDeclarations: VariableDeclaration[];
    stringLiterals: StringLiteralData[];
    variablesInScope: { [key: string]: Register };
    makeTemporary: (name: string) => Register;
    makeLabel: (name: string) => string;
};

export const stringLiteralName = ({ id, value }: StringLiteralData) =>
    `string_literal_${id}_${value.replace(/[^a-zA-Z]/g, '')}`;

export type RegisterAssignment<TargetRegister> = { [key: string]: TargetRegister };

export const saveRegistersCode = <TargetRegister>(
    registerAssignment: RegisterAssignment<TargetRegister>
): TargetThreeAddressStatement<TargetRegister>[] =>
    Object.values(registerAssignment).map(targetRegister => ({
        kind: 'push' as 'push',
        register: targetRegister,
        why: 'Push register to preserve it',
    }));

export const restoreRegistersCode = <TargetRegister>(
    registerAssignment: RegisterAssignment<TargetRegister>
): TargetThreeAddressStatement<TargetRegister>[] =>
    Object.values(registerAssignment)
        .map(targetRegister => ({
            kind: 'pop' as 'pop',
            register: targetRegister,
            why: 'Restore preserved registers',
        }))
        .reverse();

export type RegisterDescription<TargetRegister> = {
    generalPurpose: TargetRegister[];
    functionArgument: TargetRegister[];
    functionResult: TargetRegister;
    syscallArgument: TargetRegister[];
    syscallSelectAndResult: TargetRegister;
};
