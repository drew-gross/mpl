import flatten from './util/list/flatten.js';

type ExpressionCompiler = (expressions: string[][]) => string[];

export type CompiledExpression = {
    prepare: string[];
    execute: string[];
    cleanup: string[];
};

export type CompiledProgram = {
    prepare: string[];
    execute: string[];
    cleanup: string[];
};

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
