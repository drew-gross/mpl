import flatten from '../util/list/flatten.js';
import { builtinFunctions } from '../frontend.js';
import { isEqual } from 'lodash';
import debug from '../util/debug.js';
import {
    StorageSpec,
    BackendOptions,
    CompiledExpression,
    compileExpression,
    stringLiteralName,
} from '../backend-utils.js';
import { Function } from '../api.js';

export type PureRegisterTransferLanguageExpression = { why: string } & (
    | { kind: 'comment' }
    | { kind: 'move'; from: string; to: string }
    | { kind: 'loadImmediate'; value: number; destination: StorageSpec }
    | { kind: 'subtract'; lhs: StorageSpec; rhs: StorageSpec; destination: StorageSpec }
    | { kind: 'increment'; register: string }
    | { kind: 'label'; name: string }
    | { kind: 'functionLabel'; name: string }
    | { kind: 'goto'; label: string }
    | { kind: 'gotoIfEqual'; lhs: StorageSpec; rhs: StorageSpec; label: string }
    | { kind: 'gotoIfZero'; register: string; label: string }
    | { kind: 'storeGlobal'; from: string; to: string }
    | { kind: 'loadGlobal'; from: string; to: StorageSpec }
    | { kind: 'loadSymbolAddress'; to: StorageSpec; symbolName: string }
    | { kind: 'call'; function: string }
    | { kind: 'returnToCaller' }
    | { kind: 'returnValue'; source: StorageSpec });

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
    if (isEqual(currentTemporary, destination)) throw debug('todo'); // Sanity check to make sure caller remembered to provide a new temporary
    switch (ast.kind) {
        case 'number':
            return compileExpression([], ([]) => [
                { kind: 'loadImmediate', value: ast.value, destination: destination, why: '' },
            ]);
        case 'booleanLiteral':
            return compileExpression([], ([]) => [
                { kind: 'loadImmediate', value: ast.value ? 1 : 0, destination: destination, why: '' },
            ]);
        case 'stringLiteral': {
            const stringLiteralData = stringLiterals.find(({ value }) => value == ast.value);
            if (!stringLiteralData) throw debug('todo');
            return compileExpression([], ([]) => [
                {
                    kind: 'loadSymbolAddress',
                    symbolName: stringLiteralName(stringLiteralData),
                    to: destination,
                    why: 'Load string literal address into register',
                },
            ]);
        }
        case 'returnStatement':
            const subExpression = recurse({
                ast: ast.expression,
                destination: currentTemporary,
                currentTemporary: nextTemporary(currentTemporary),
            });
            return compileExpression([subExpression], ([e1]) => [
                ...e1,
                {
                    kind: 'returnValue',
                    source: currentTemporary,
                    why: 'Retrun previous expression',
                },
            ]);
        case 'subtraction': {
            const leftSideDestination = destination;
            if (leftSideDestination.type !== 'register') throw debug('todo');
            const rightSideDestination = currentTemporary;
            if (rightSideDestination.type !== 'register') throw debug('todo');
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
            if (currentTemporary.type !== 'register') throw debug('todo'); // TODO: Figure out how to guarantee this doesn't happen
            if (destination.type !== 'register') throw debug('todo');
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
                debug('todo');
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
                        throw debug('todo');
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
        case 'equality': {
            if (ast.type.name == 'String') {
                // Put left in s0 and right in s1 for passing to string equality function
                const storeLeftInstructions = recurse({
                    ast: ast.lhs,
                    destination: {
                        type: 'register',
                        destination: knownRegisters.argument1,
                    },
                });
                const storeRightInstructions = recurse({
                    ast: ast.rhs,
                    destination: {
                        type: 'register',
                        destination: knownRegisters.argument2,
                    },
                });
                return compileExpression([storeLeftInstructions, storeRightInstructions], ([e1, e2]) => [
                    { kind: 'comment', why: 'Store left side in s0' },
                    ...e1,
                    { kind: 'comment', why: 'Store right side in s1' },
                    ...e2,
                    { kind: 'call', function: 'stringEquality', why: 'Call stringEquality' },
                    {
                        kind: 'move',
                        from: knownRegisters.functionResult,
                        to: (destination as any).destination,
                        why: `Return value in ${knownRegisters.functionResult}. Move to destination`,
                    },
                ]);
            } else {
                const leftSideDestination = currentTemporary;
                const rightSideDestination = destination;
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

                const equalLabel = makeLabel('equal');
                const endOfConditionLabel = makeLabel('endOfCondition');

                return compileExpression([storeLeftInstructions, storeRightInstructions], ([storeLeft, storeRight]) => [
                    { kind: 'comment', why: 'Store left side of equality in temporary' },
                    ...storeLeft,
                    { kind: 'comment', why: 'Store right side of equality in temporary' },
                    ...storeRight,
                    {
                        kind: 'gotoIfEqual',
                        lhs: leftSideDestination,
                        rhs: rightSideDestination,
                        label: equalLabel,
                        why: 'Goto set 1 if equal',
                    },
                    { kind: 'loadImmediate', value: 0, destination: destination, why: 'Not equal, set 0' },
                    { kind: 'goto', label: endOfConditionLabel, why: 'And goto exit' },
                    { kind: 'label', name: equalLabel, why: 'Sides are equal' },
                    { kind: 'loadImmediate', value: 1, destination: destination, why: 'Set 1' },
                    { kind: 'label', name: endOfConditionLabel, why: 'End of condition' },
                ]);
            }
        }
        default:
            throw debug('todo');
    }
};

export const constructFunction = (
    f: Function,
    astTranslator,
    globalDeclarations,
    stringLiterals,
    resultRegister,
    argumentRegisters: string[],
    firstTemporary: StorageSpec,
    nextTemporary,
    registerSaver,
    registerRestorer
): RegisterTransferLanguageExpression[] => {
    // Statments are either assign or return right now, so we need one register for each statement, minus the return statement.
    const scratchRegisterCount = f.temporaryCount + f.statements.length - 1;

    if (f.parameters.length > 3) throw debug('todo'); // Don't want to deal with this yet.
    if (argumentRegisters.length < 3) throw debug('todo');
    const registerAssignment: any = {};
    f.parameters.forEach((parameter, index) => {
        registerAssignment[parameter.name] = {
            type: 'register',
            destination: argumentRegisters[index],
        };
    });

    let currentTemporary = firstTemporary;
    f.statements.forEach(statement => {
        if (statement.kind === 'typedDeclarationAssignment') {
            registerAssignment[statement.destination] = currentTemporary;
            currentTemporary = nextTemporary(currentTemporary);
        }
    });

    const functionCode = flatten(
        f.statements.map(statement => {
            const compiledProgram = astTranslator({
                ast: statement,
                registerAssignment,
                destination: resultRegister, // TODO: Not sure how this works. Maybe it doesn't.
                currentTemporary,
                globalDeclarations,
                stringLiterals,
            });
            const freeLocals = f.variables
                // TODO: Make a better memory model for frees.
                .filter(s => s.location === 'Stack')
                .filter(s => s.type.name == 'String')
                .map(s => {
                    const memoryForVariable: StorageSpec = registerAssignment[s.name];
                    if (memoryForVariable.type !== 'register') throw debug('todo');
                    return [
                        { kind: 'move', from: memoryForVariable.destination, to: argumentRegisters[0] },
                        { kind: 'call', function: 'my_free', why: 'Free Stack String at end of scope' },
                    ];
                });

            return [
                ...compiledProgram.prepare,
                ...compiledProgram.execute,
                ...compiledProgram.cleanup,
                // ...flatten(freeLocals), // TODO: Freeing locals should be necessary...
            ];
        })
    );
    return [
        { kind: 'functionLabel', name: f.name, why: f.name },
        ...registerSaver(scratchRegisterCount),
        ...functionCode,
        ...registerRestorer(scratchRegisterCount),
        { kind: 'returnToCaller', why: `End of ${f.name}` },
    ];
};
