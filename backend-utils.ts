import { isEqual } from 'lodash';
import * as Ast from './ast.js';
import debug from './util/debug.js';
import { VariableDeclaration, BackendInputs, ExecutionResult, Function, StringLiteralData } from './api.js';
import flatten from './util/list/flatten.js';

type PureRegisterTransferLanguageExpression =
    | { kind: 'move'; from: string; to: string }
    | { kind: 'loadImmediate'; value: number; destination: StorageSpec }
    | { kind: 'subtract'; lhs: StorageSpec; rhs: StorageSpec; destination: StorageSpec }
    | { kind: 'label'; name: string }
    | { kind: 'goto'; label: string }
    | { kind: 'gotoIfEqual'; lhs: StorageSpec; rhs: StorageSpec; label: string }
    | { kind: 'return'; source: StorageSpec };

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

export const astToRegisterTransferLanguage = (
    input: BackendOptions,
    nextTemporary,
    makeLabel,
    recurse
): CompiledExpression => {
    const { ast, registerAssignment, destination, currentTemporary, globalDeclarations, stringLiterals } = input;
    if (isEqual(currentTemporary, destination)) throw debug(); // Sanity check to make sure caller remembered to provide a new temporary
    switch (ast.kind) {
        case 'number':
            return compileExpression([], ([]) => [
                { kind: 'loadImmediate', value: ast.value, destination: destination, why: '' },
            ]);
        case 'booleanLiteral':
            return compileExpression([], ([]) => [
                { kind: 'loadImmediate', value: ast.value ? 1 : 0, destination: destination, why: '' },
            ]);
        case 'returnStatement':
            const subExpression = recurse({
                ast: ast.expression,
                destination: currentTemporary,
                currentTemporary: nextTemporary(currentTemporary),
            });
            return compileExpression([subExpression], ([e1]) => [
                ...e1,
                {
                    kind: 'return',
                    source: currentTemporary,
                    why: 'Retrun previous expression',
                },
            ]);
        case 'subtraction': {
            const leftSideDestination = destination;
            if (leftSideDestination.type !== 'register') throw debug();
            const rightSideDestination = currentTemporary;
            if (rightSideDestination.type !== 'register') throw debug();
            const subExpressionTemporary = nextTemporary(currentTemporary);

            const storeLeftInstructions = recurse({
                ast: ast.lhs,
                destination: leftSideDestination,
                currentTemporary: subExpressionTemporary,
            });
            const storeRightInstructions = recurse({
                ast: ast.rhs,
                destination: rightSideDestination,
                currentTemporary: subExpressionTemporary,
            });
            return compileExpression([storeLeftInstructions, storeRightInstructions], ([storeLeft, storeRight]) => [
                `# Store left side in temporary (${leftSideDestination.destination})`,
                ...storeLeft,
                `# Store right side in destination (${rightSideDestination.destination})`,
                ...storeRight,
                {
                    kind: 'subtract',
                    lhs: leftSideDestination,
                    rhs: rightSideDestination,
                    destination: destination,
                    why: 'Evaluate subtraction',
                },
            ]);
        }
        case 'ternary': {
            const booleanTemporary = currentTemporary;
            const subExpressionTemporary = nextTemporary(currentTemporary);
            const falseBranchLabel = makeLabel('falseBranch');
            const endOfTernaryLabel = makeLabel('endOfTernary');
            const boolExpression = recurse({
                ast: ast.condition,
                destination: booleanTemporary,
                currentTemporary: subExpressionTemporary,
            });
            const ifTrueExpression = recurse({
                ast: ast.ifTrue,
                currentTemporary: subExpressionTemporary,
            });
            const ifFalseExpression = recurse({
                ast: ast.ifFalse,
                currentTemporary: subExpressionTemporary,
            });
            return compileExpression([boolExpression, ifTrueExpression, ifFalseExpression], ([e1, e2, e3]) => [
                ...e1,
                {
                    kind: 'gotoIfEqual',
                    lhs: booleanTemporary,
                    rhs: { type: 'register', destination: '$0' },
                    label: falseBranchLabel,
                    why: 'Go to false branch if zero',
                },
                ...e2,
                { kind: 'goto', label: endOfTernaryLabel, why: 'Jump to end of ternary' },
                { kind: 'label', name: falseBranchLabel, why: 'False branch begin' },
                ...e3,
                { kind: 'label', name: endOfTernaryLabel, why: 'End of ternary label' },
            ]);
        }
        default:
            throw debug();
    }
};
