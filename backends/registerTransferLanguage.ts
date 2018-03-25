import flatten from '../util/list/flatten.js';
import { builtinFunctions } from '../frontend.js';
import { isEqual } from 'lodash';
import debug from '../util/debug.js';
import { StorageSpec, BackendOptions, CompiledExpression, compileExpression } from '../backend-utils.js';

export type PureRegisterTransferLanguageExpression = { why: string } & (
    | { kind: 'move'; from: string; to: string }
    | { kind: 'loadImmediate'; value: number; destination: StorageSpec }
    | { kind: 'subtract'; lhs: StorageSpec; rhs: StorageSpec; destination: StorageSpec }
    | { kind: 'label'; name: string }
    | { kind: 'goto'; label: string }
    | { kind: 'gotoIfEqual'; lhs: StorageSpec; rhs: StorageSpec; label: string }
    | { kind: 'storeGlobal'; from: string; to: string }
    | { kind: 'loadGlobal'; from: string; to: StorageSpec }
    | { kind: 'loadSymbolAddress'; to: StorageSpec; symbolName: string }
    | { kind: 'call'; function: string }
    | { kind: 'return'; source: StorageSpec });

// TODO: get rid of string!
export type RegisterTransferLanguageExpression = string | PureRegisterTransferLanguageExpression;

export const astToRegisterTransferLanguage = (
    input: BackendOptions,
    knownRegisters,
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
        case 'functionLiteral':
            return compileExpression([], ([]) => [
                {
                    kind: 'loadSymbolAddress',
                    to: destination,
                    symbolName: ast.deanonymizedName,
                    why: 'Loading function into register',
                },
            ]);
        case 'callExpression': {
            if (currentTemporary.type !== 'register') throw debug(); // TODO: Figure out how to guarantee this doesn't happen
            if (destination.type !== 'register') throw debug();
            const functionName = ast.name;
            let callInstructions: (string | RegisterTransferLanguageExpression)[] = [];
            if (builtinFunctions.map(b => b.name).includes(functionName)) {
                callInstructions = [
                    {
                        kind: 'loadSymbolAddress',
                        symbolName: functionName,
                        to: currentTemporary,
                        why: 'Load runtime function',
                    },
                    { kind: 'call', function: currentTemporary.destination, why: 'Call runtime function' },
                ];
            } else if (globalDeclarations.some(declaration => declaration.name === functionName)) {
                callInstructions = [
                    {
                        kind: 'loadGlobal',
                        from: functionName,
                        to: currentTemporary,
                        why: 'Load global function pointer',
                    },
                    { kind: 'call', function: currentTemporary.destination, why: 'Call global function' },
                ];
            } else if (functionName in registerAssignment) {
                callInstructions = [
                    {
                        kind: 'call',
                        function: (registerAssignment[functionName] as any).destination,
                        why: 'Call register function',
                    },
                ];
            } else {
                debug();
            }

            const computeArgumentsMips = ast.arguments.map((argument, index) => {
                let register;
                switch (index) {
                    case 0:
                        register = knownRegisters.argument1;
                        break;
                    case 1:
                        register = knownRegisters.argument2;
                        break;
                    case 2:
                        register = knownRegisters.argument3;
                        break;
                    default:
                        throw debug();
                }
                return recurse({
                    ast: argument,
                    destination: { type: 'register', destination: register },
                    currentTemporary: nextTemporary(currentTemporary),
                });
            });

            const argumentComputerToMips = (argumentComputer, index) => [
                `# Put argument ${index} in register`,
                ...argumentComputer,
            ];

            return compileExpression(computeArgumentsMips, argumentComputers => [
                ...flatten(argumentComputers.map(argumentComputerToMips)),
                `# call ${functionName}`,
                ...callInstructions,
                {
                    kind: 'move',
                    to: (destination as any).destination,
                    from: knownRegisters.functionResult,
                    why: `Move result from ${knownRegisters.functionResult} into destination`,
                },
            ]);
        }
        default:
            throw debug();
    }
};
