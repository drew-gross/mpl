import flatten from './util/list/flatten.js';

type ExpressionCompiler = (expressions: string[][]) => string[];

export type CompiledExpression = {
    prepare: string[],
    execute: string[],
    cleanup: string[],
}

export type CompiledProgram = {
    prepare: string[],
    execute: string[],
    cleanup: string[],
}

export const compileExpression = (
    subExpressions: CompiledExpression[],
    expressionCompiler: ExpressionCompiler
): CompiledExpression => ({
    prepare: flatten(subExpressions.map(input => input.prepare)),
    execute: expressionCompiler(subExpressions.map(input => input.execute)),
    cleanup: flatten(subExpressions.map(input => input.cleanup)).reverse(),
});
