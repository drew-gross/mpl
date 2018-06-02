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
    saveRegistersCode,
    restoreRegistersCode,
    storageSpecToString,
} from '../backend-utils.js';
import { Function } from '../api.js';

type SyscallName = 'printInt' | 'print' | 'sbrk' | 'mmap' | 'exit';

export type RegisterTransferLanguageExpression = { why: string } & (
    | { kind: 'comment' }
    | { kind: 'syscall'; name: SyscallName; arguments: (StorageSpec | number)[]; destination: StorageSpec | undefined }
    | { kind: 'move'; from: StorageSpec; to: StorageSpec }
    | { kind: 'loadImmediate'; value: number; destination: StorageSpec }
    | { kind: 'addImmediate'; register: StorageSpec; amount: number }
    | { kind: 'subtract'; lhs: StorageSpec; rhs: StorageSpec; destination: StorageSpec }
    | { kind: 'add'; lhs: StorageSpec; rhs: StorageSpec; destination: StorageSpec }
    | { kind: 'multiply'; lhs: StorageSpec; rhs: StorageSpec; destination: StorageSpec }
    | { kind: 'increment'; register: StorageSpec }
    | { kind: 'label'; name: string }
    | { kind: 'functionLabel'; name: string }
    | { kind: 'goto'; label: string }
    | { kind: 'gotoIfEqual'; lhs: StorageSpec; rhs: StorageSpec; label: string }
    | { kind: 'gotoIfNotEqual'; lhs: StorageSpec; rhs: StorageSpec; label: string }
    | { kind: 'gotoIfZero'; register: StorageSpec; label: string }
    | { kind: 'gotoIfGreater'; lhs: StorageSpec; rhs: StorageSpec; label: string }
    | { kind: 'storeGlobal'; from: StorageSpec; to: StorageSpec }
    | { kind: 'loadGlobal'; from: string; to: StorageSpec }
    | { kind: 'storeMemory'; from: StorageSpec; address: StorageSpec; offset: number }
    | { kind: 'storeMemoryByte'; address: StorageSpec; contents: StorageSpec }
    | { kind: 'storeZeroToMemory'; address: StorageSpec; offset: number }
    | { kind: 'loadMemory'; from: StorageSpec; to: StorageSpec; offset: number }
    | { kind: 'loadMemoryByte'; address: StorageSpec; to: StorageSpec }
    | { kind: 'loadSymbolAddress'; to: StorageSpec; symbolName: string }
    | { kind: 'callByName'; function: string }
    | { kind: 'callByRegister'; function: StorageSpec }
    | { kind: 'returnToCaller' }
    | { kind: 'returnValue'; source: StorageSpec } // TODO: replace this with a move to functionResult
    | { kind: 'push'; register: StorageSpec }
    | { kind: 'pop'; register: StorageSpec });

export type RegisterTransferLanguage = RegisterTransferLanguageExpression[];

export type RegisterTransferLanguageFunction = {
    instructions: RegisterTransferLanguage;
    numRegistersToSave: number;
    name: string;
    isMain: boolean;
};

export const toString = (rtx: RegisterTransferLanguageExpression): string => {
    switch (rtx.kind) {
        case 'comment':
            return ``;
        case 'syscall':
            return 'syscall';
        case 'move':
            return `${storageSpecToString(rtx.to)} = ${storageSpecToString(rtx.from)}`;
        case 'loadImmediate':
            return `${storageSpecToString(rtx.destination)} = ${rtx.value}`;
        case 'addImmediate':
            return `${storageSpecToString(rtx.register)} += ${rtx.amount}`;
        case 'subtract':
            return `${storageSpecToString(rtx.destination)} = ${storageSpecToString(rtx.lhs)} - ${storageSpecToString(
                rtx.rhs
            )}`;
        case 'add':
            return `${storageSpecToString(rtx.destination)} = ${storageSpecToString(rtx.lhs)} + ${storageSpecToString(
                rtx.rhs
            )}`;
        case 'multiply':
            return `${storageSpecToString(rtx.destination)} = ${storageSpecToString(rtx.lhs)} * ${storageSpecToString(
                rtx.rhs
            )}`;
        case 'increment':
            return `${storageSpecToString(rtx.register)}++`;
        case 'label':
        case 'functionLabel':
            return `${rtx.name}:`;
        case 'goto':
            return `goto ${rtx.label}`;
        case 'gotoIfEqual':
            return `goto ${rtx.label} if ${storageSpecToString(rtx.lhs)} == ${storageSpecToString(rtx.rhs)}`;
        case 'gotoIfNotEqual':
            return `goto ${rtx.label} if ${storageSpecToString(rtx.lhs)} != ${storageSpecToString(rtx.rhs)}`;
        case 'gotoIfZero':
            return `goto ${rtx.label} if ${storageSpecToString(rtx.register)} == 0`;
        case 'gotoIfGreater':
            return `goto ${rtx.label} if ${storageSpecToString(rtx.lhs)} > ${storageSpecToString(rtx.rhs)}`;
        case 'storeGlobal':
            return `*${storageSpecToString(rtx.to)} = ${storageSpecToString(rtx.from)}`;
        case 'loadGlobal':
            return `${storageSpecToString(rtx.to)} = &${rtx.from}`;
        case 'storeMemory':
            return `*(${storageSpecToString(rtx.address)} + ${rtx.offset}) = ${storageSpecToString(rtx.from)}`;
        case 'storeMemoryByte':
            return `*${storageSpecToString(rtx.address)} = ${storageSpecToString(rtx.contents)}`;
        case 'storeZeroToMemory':
            return `*${storageSpecToString(rtx.address)} = 0`;
        case 'loadMemory':
            return `${storageSpecToString(rtx.to)} = *(${storageSpecToString(rtx.from)} + ${rtx.offset})`;
        case 'loadMemoryByte':
            return `${storageSpecToString(rtx.to)} = *${storageSpecToString(rtx.address)}`;
        case 'loadSymbolAddress':
            return `${storageSpecToString(rtx.to)} = &${rtx.symbolName}`;
        case 'callByRegister':
            return `${storageSpecToString(rtx.function)}()`;
        case 'callByName':
            return `${rtx.function}()`;
        case 'returnToCaller':
            return `return`;
        case 'returnValue':
            return `ret = ${storageSpecToString(rtx.source)}`;
        case 'push':
            return `push ${storageSpecToString(rtx.register)}`;
        case 'pop':
            return `pop ${storageSpecToString(rtx.register)}`;
        default:
            throw debug('Unrecognized RTX kind in toString');
    }
};

export const astToRegisterTransferLanguage = (
    input: BackendOptions,
    nextTemporary,
    makeLabel
): CompiledExpression<RegisterTransferLanguageExpression> => {
    const { ast, registerAssignment, destination, currentTemporary, globalDeclarations, stringLiterals } = input;
    if (isEqual(currentTemporary, destination)) throw debug('todo'); // Sanity check to make sure caller remembered to provide a new temporary
    const recurse = newInput => astToRegisterTransferLanguage({ ...input, ...newInput }, nextTemporary, makeLabel);
    switch (ast.kind) {
        case 'number':
            return compileExpression<RegisterTransferLanguageExpression>([], ([]) => [
                { kind: 'loadImmediate', value: ast.value, destination: destination, why: 'Load number literal' },
            ]);
        case 'booleanLiteral':
            return compileExpression<RegisterTransferLanguageExpression>([], ([]) => [
                {
                    kind: 'loadImmediate',
                    value: ast.value ? 1 : 0,
                    destination,
                    why: 'Load boolean literal',
                },
            ]);
        case 'stringLiteral': {
            const stringLiteralData = stringLiterals.find(({ value }) => value == ast.value);
            if (!stringLiteralData) throw debug('todo');
            return compileExpression<RegisterTransferLanguageExpression>([], ([]) => [
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
            return compileExpression<RegisterTransferLanguageExpression>([subExpression], ([e1]) => [
                ...e1,
                {
                    kind: 'returnValue',
                    source: currentTemporary,
                    why: 'Retrun previous expression',
                },
            ]);
        case 'subtraction': {
            const leftSideDestination = destination;
            if (typeof leftSideDestination !== 'string' && leftSideDestination.type !== 'register') throw debug('todo');
            const rightSideDestination = currentTemporary;
            if (typeof rightSideDestination !== 'string' && rightSideDestination.type !== 'register')
                throw debug('todo');
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
            return compileExpression<RegisterTransferLanguageExpression>(
                [storeLeftInstructions, storeRightInstructions],
                ([storeLeft, storeRight]) => [
                    { kind: 'comment', why: 'Store left side in temporary' },
                    ...storeLeft,
                    { kind: 'comment', why: 'Store right side in destination' },
                    ...storeRight,
                    {
                        kind: 'subtract',
                        lhs: leftSideDestination,
                        rhs: rightSideDestination,
                        destination: destination,
                        why: 'Evaluate subtraction',
                    },
                ]
            );
        }
        case 'addition': {
            if (typeof destination !== 'string' && destination.type !== 'register') throw debug('todo');
            const leftSideDestination = currentTemporary;
            if (typeof leftSideDestination !== 'string' && leftSideDestination.type !== 'register') throw debug('todo');
            const rightSideDestination = destination;
            if (typeof rightSideDestination !== 'string' && rightSideDestination.type !== 'register')
                throw debug('todo');
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
            return compileExpression<RegisterTransferLanguageExpression>(
                [storeLeftInstructions, storeRightInstructions],
                ([storeLeft, storeRight]) => [
                    { kind: 'comment', why: 'Store left side in temporary' },
                    ...storeLeft,
                    { kind: 'comment', why: 'Store right side in destination' },
                    ...storeRight,
                    {
                        kind: 'add',
                        lhs: leftSideDestination,
                        rhs: rightSideDestination,
                        destination: destination,
                        why: 'Evaluate addition',
                    },
                ]
            );
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
            return compileExpression<RegisterTransferLanguageExpression>(
                [boolExpression, ifTrueExpression, ifFalseExpression],
                ([e1, e2, e3]) => [
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
                ]
            );
        }
        case 'functionLiteral':
            return compileExpression<RegisterTransferLanguageExpression>([], ([]) => [
                {
                    kind: 'loadSymbolAddress',
                    to: destination,
                    symbolName: ast.deanonymizedName,
                    why: 'Loading function into register',
                },
            ]);
        case 'callExpression': {
            if (typeof currentTemporary !== 'string' && currentTemporary.type !== 'register') throw debug('todo'); // TODO: Figure out how to guarantee this doesn't happen
            if (typeof destination !== 'string' && destination.type !== 'register') throw debug('todo');
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
                    { kind: 'callByRegister', function: currentTemporary, why: 'Call runtime function' },
                ];
            } else if (globalDeclarations.some(declaration => declaration.name === functionName)) {
                callInstructions = [
                    {
                        kind: 'loadGlobal',
                        from: functionName,
                        to: currentTemporary,
                        why: 'Load global function pointer',
                    },
                    { kind: 'callByRegister', function: currentTemporary, why: 'Call global function' },
                ];
            } else if (functionName in registerAssignment) {
                callInstructions = [
                    {
                        kind: 'callByRegister',
                        function: registerAssignment[functionName],
                        why: 'Call register function',
                    },
                ];
            } else {
                debug('todo');
            }

            const computeArgumentsMips = ast.arguments.map((argument, index) => {
                let register: StorageSpec;
                switch (index) {
                    case 0:
                        register = 'functionArgument1';
                        break;
                    case 1:
                        register = 'functionArgument2';
                        break;
                    case 2:
                        register = 'functionArgument3';
                        break;
                    default:
                        throw debug('todo');
                }
                return recurse({
                    ast: argument,
                    destination: register,
                    currentTemporary: nextTemporary(currentTemporary),
                });
            });

            const argumentComputerToMips = (argumentComputer, index) => [
                { kind: 'comment', why: 'Put argument ${index} in register' },
                ...argumentComputer,
            ];

            return compileExpression<RegisterTransferLanguageExpression>(computeArgumentsMips, argumentComputers => [
                ...flatten(argumentComputers.map(argumentComputerToMips)),
                { kind: 'comment', why: 'call ${functionName}' },
                ...callInstructions,
                {
                    kind: 'move',
                    to: destination,
                    from: 'functionResult',
                    why: 'Move result from functionResult into destination',
                },
            ]);
        }
        case 'equality': {
            if (ast.type.name == 'String') {
                // Put left in s0 and right in s1 for passing to string equality function
                const storeLeftInstructions = recurse({
                    ast: ast.lhs,
                    destination: 'functionArgument1',
                });
                const storeRightInstructions = recurse({
                    ast: ast.rhs,
                    destination: 'functionArgument2',
                });
                return compileExpression<RegisterTransferLanguageExpression>(
                    [storeLeftInstructions, storeRightInstructions],
                    ([e1, e2]) => [
                        { kind: 'comment', why: 'Store left side in s0' },
                        ...e1,
                        { kind: 'comment', why: 'Store right side in s1' },
                        ...e2,
                        { kind: 'callByName', function: 'stringEquality', why: 'Call stringEquality' },
                        {
                            kind: 'move',
                            from: 'functionResult',
                            to: destination,
                            why: 'Return value in functionResult to destination',
                        },
                    ]
                );
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

                return compileExpression<RegisterTransferLanguageExpression>(
                    [storeLeftInstructions, storeRightInstructions],
                    ([storeLeft, storeRight]) => [
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
                    ]
                );
            }
        }
        case 'typedDeclarationAssignment': {
            const lhs = ast.destination;
            if (globalDeclarations.some(declaration => declaration.name === lhs)) {
                const subExpressionTemporary = nextTemporary(currentTemporary);
                const rhs = recurse({
                    ast: ast.expression,
                    destination: currentTemporary,
                    currentTemporary: subExpressionTemporary,
                });
                const declaration = globalDeclarations.find(declaration => declaration.name === lhs);
                if (!declaration) throw debug('todo');
                if (typeof currentTemporary !== 'string' && currentTemporary.type !== 'register') throw debug('todo');
                switch (declaration.type.name) {
                    case 'Function':
                    case 'Integer':
                        return compileExpression<RegisterTransferLanguageExpression>([rhs], ([e1]) => [
                            ...e1,
                            {
                                kind: 'storeGlobal',
                                from: currentTemporary,
                                to: { type: 'register', destination: lhs },
                                why: `Put ${declaration.type.name} into global`,
                            },
                        ]);
                    case 'String':
                        return compileExpression<RegisterTransferLanguageExpression>([rhs], ([e1]) => [
                            ...e1,
                            {
                                kind: 'move',
                                to: 'functionArgument1',
                                from: currentTemporary,
                                why: 'Put string pointer into temporary',
                            },
                            { kind: 'callByName', function: 'length', why: 'Get string length' },
                            {
                                kind: 'increment',
                                register: 'functionResult',
                                why: 'Add one for null terminator',
                            },
                            {
                                kind: 'move',
                                to: 'functionArgument1',
                                from: 'functionResult',
                                why: 'Move length to argument1',
                            },
                            { kind: 'callByName', function: 'my_malloc', why: 'Allocate that much space' },
                            {
                                kind: 'move',
                                to: 'functionArgument1',
                                from: currentTemporary,
                                why: 'Move destination to argument 1',
                            },
                            {
                                kind: 'move',
                                to: 'functionArgument2',
                                from: 'functionResult',
                                why: 'Move output pointer to argument 2',
                            },
                            { kind: 'callByName', function: 'string_copy', why: 'Copy string into allocated space' },
                            {
                                kind: 'storeGlobal',
                                from: 'functionResult',
                                to: { type: 'register', destination: lhs },
                                why: 'Store into global',
                            },
                        ]);
                    default:
                        throw debug('todo');
                }
            } else if (lhs in registerAssignment) {
                return recurse({
                    ast: ast.expression,
                    // TODO: Allow spilling of variables
                    destination: {
                        type: 'register',
                        destination: (registerAssignment[lhs] as any).destination,
                    },
                });
            } else {
                throw debug('todo');
            }
        }
        case 'reassignment': {
            const lhs = ast.destination;
            if (globalDeclarations.some(declaration => declaration.name === lhs)) {
                const subExpressionTemporary = nextTemporary(currentTemporary);
                const savedPointerForFreeing = subExpressionTemporary;
                const rhs: CompiledExpression<RegisterTransferLanguageExpression> = recurse({
                    ast: ast.expression,
                    destination: currentTemporary,
                    currentTemporary: nextTemporary(subExpressionTemporary),
                });
                const declaration = globalDeclarations.find(declaration => declaration.name === lhs);
                if (!declaration) throw debug('todo');
                if (typeof currentTemporary !== 'string' && currentTemporary.type !== 'register') throw debug('todo');
                switch (declaration.type.name) {
                    case 'Function':
                    case 'Integer':
                        return compileExpression<RegisterTransferLanguageExpression>([rhs], ([e1]) => [
                            ...e1,
                            {
                                kind: 'storeGlobal',
                                from: currentTemporary,
                                to: { type: 'register', destination: lhs },
                                why: 'Store into global',
                            },
                        ]);
                    case 'String':
                        if (savedPointerForFreeing.type !== 'register') throw debug('Need register');
                        const prepAndCleanup = {
                            prepare: [
                                {
                                    kind: 'loadGlobal',
                                    to: savedPointerForFreeing,
                                    from: lhs,
                                    why: 'Save global for freeing after assignment',
                                } as RegisterTransferLanguageExpression,
                            ],
                            execute: [],
                            cleanup: [
                                {
                                    kind: 'move',
                                    from: savedPointerForFreeing,
                                    to: 'functionArgument1',
                                    why: 'Move global to argument 1 of free',
                                },
                                {
                                    kind: 'callByName',
                                    function: 'my_free',
                                    why: 'Free string that is no longer accessible',
                                },
                            ] as RegisterTransferLanguageExpression[],
                        };
                        return compileExpression<RegisterTransferLanguageExpression>(
                            [rhs, prepAndCleanup],
                            ([e1, _]) => [
                                ...e1,
                                {
                                    kind: 'move',
                                    from: currentTemporary,
                                    to: 'functionArgument1',
                                    why: 'Move from temporary to argument 1',
                                },
                                { kind: 'callByName', function: 'length', why: 'Get length of new string' },
                                {
                                    kind: 'move',
                                    from: 'functionResult',
                                    to: 'functionArgument1',
                                    why: 'Move length of new string to argument of malloc',
                                },
                                { kind: 'callByName', function: 'my_malloc', why: 'Allocate space for new string' },
                                {
                                    kind: 'storeGlobal',
                                    from: 'functionResult',
                                    to: { type: 'register', destination: lhs },
                                    why: 'Store location of allocated memory to global',
                                },
                                {
                                    kind: 'move',
                                    from: 'functionResult',
                                    to: 'functionArgument2',
                                    why: 'Move output pointer to argument 2 of string_copy',
                                },
                                {
                                    kind: 'move',
                                    from: currentTemporary,
                                    to: 'functionArgument1',
                                    why: 'move destination to argument 1 of string_copy',
                                },
                                { kind: 'callByName', function: 'string_copy', why: 'Copy new string to destination' },
                            ]
                        );
                    default:
                        throw debug('todo');
                }
            } else if (lhs in registerAssignment) {
                return recurse({
                    ast: ast.expression,
                    // TODO: Allow spilling of variables
                    destination: {
                        type: 'register',
                        destination: `${(registerAssignment[lhs] as any).destination}`,
                    },
                });
            } else {
                throw debug('todo');
            }
        }
        case 'concatenation': {
            if (typeof destination !== 'string' && destination.type !== 'register') throw debug('todo');
            const leftSideDestination = currentTemporary;
            if (typeof leftSideDestination !== 'string' && leftSideDestination.type !== 'register') throw debug('todo');
            const rightSideDestination = nextTemporary(leftSideDestination);
            if (rightSideDestination.type !== 'register') throw debug('todo');
            const subExpressionTemporary = nextTemporary(rightSideDestination);
            const newStringLengthTemporary = nextTemporary(subExpressionTemporary);
            if (newStringLengthTemporary.type !== 'register') throw debug('todo');
            const mallocResultTemporary = newStringLengthTemporary; // Don't need length after malloc is done

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
            const cleanup: CompiledExpression<RegisterTransferLanguageExpression> = {
                prepare: [],
                execute: [],
                cleanup: [
                    {
                        kind: 'move',
                        from: mallocResultTemporary,
                        to: 'functionArgument1',
                        why: 'Move pointer to new string to argument1',
                    },
                    // TODO: maybe not valid? This destination may have been reused for something else by the time we get to cleanup
                    { kind: 'callByName', function: 'my_free', why: 'Freeing temporary from concat' },
                ],
            };
            return compileExpression<RegisterTransferLanguageExpression>(
                [storeLeftInstructions, storeRightInstructions, cleanup],
                ([e1, e2, _]) => [
                    {
                        kind: 'loadImmediate',
                        value: 1,
                        destination: newStringLengthTemporary,
                        why: 'Create a temporary to store new string length. Start with 1 for null terminator.',
                    },
                    ...e1,
                    ...e2,
                    {
                        kind: 'move',
                        from: leftSideDestination,
                        to: 'functionArgument1',
                        why: 'Move lhs to argument1',
                    },
                    { kind: 'callByName', function: 'length', why: 'Compute the length of lhs' },
                    {
                        kind: 'add',
                        lhs: 'functionResult',
                        rhs: newStringLengthTemporary,
                        destination: newStringLengthTemporary,
                        why: 'add lhs length to length temporary',
                    },
                    {
                        kind: 'move',
                        from: rightSideDestination,
                        to: 'functionArgument1',
                        why: 'Move rhs to argument1',
                    },
                    { kind: 'callByName', function: 'length', why: 'Compute the length of lhs' },
                    {
                        kind: 'add',
                        lhs: 'functionResult',
                        rhs: newStringLengthTemporary,
                        destination: newStringLengthTemporary,
                        why: 'add rhs length to length temporary',
                    },
                    {
                        kind: 'move',
                        from: newStringLengthTemporary,
                        to: 'functionArgument1',
                        why: 'Move new string length to argument1',
                    },
                    { kind: 'callByName', function: 'my_malloc', why: 'Malloc that much space' },
                    {
                        kind: 'move',
                        from: 'functionResult',
                        to: mallocResultTemporary,
                        why: 'Move malloc result to temporary',
                    },
                    {
                        kind: 'move',
                        from: leftSideDestination,
                        to: 'functionArgument1',
                        why: 'Move lhs to argument1',
                    },
                    {
                        kind: 'move',
                        from: rightSideDestination,
                        to: 'functionArgument2',
                        why: 'Move rhs to argument2',
                    },
                    {
                        kind: 'move',
                        from: mallocResultTemporary,
                        to: 'functionArgument3',
                        why: 'Move destintion to argument3',
                    },
                    {
                        kind: 'callByName',
                        function: 'string_concatenate',
                        why: 'Concatenate the strings and write to malloced space',
                    },
                    {
                        kind: 'move',
                        from: mallocResultTemporary,
                        to: destination,
                        why: 'Move new string pointer to final destination',
                    },
                ]
            );
        }
        case 'identifier': {
            // TODO: Better handle identifiers here. Also just better storage/scope chains?
            const identifierName = ast.value;
            if (globalDeclarations.some(declaration => declaration.name === identifierName)) {
                const declaration = globalDeclarations.find(declaration => declaration.name === identifierName);
                if (!declaration) throw debug('todo');
                return compileExpression<RegisterTransferLanguageExpression>([], ([]) => [
                    {
                        kind: 'loadGlobal',
                        to: destination,
                        from: identifierName,
                        why: `Load ${identifierName} from global into register`,
                    },
                ]);
            }
            const identifierRegister = registerAssignment[identifierName];
            debugger;
            return compileExpression<RegisterTransferLanguageExpression>([], ([]) => [
                {
                    kind: 'move',
                    from: identifierRegister,
                    to: destination,
                    why: `Move from ${identifierName} into destination`,
                },
            ]);
        }
        case 'product': {
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
            return compileExpression<RegisterTransferLanguageExpression>(
                [storeLeftInstructions, storeRightInstructions],
                ([storeLeft, storeRight]) => [
                    {
                        kind: 'comment',
                        why: `Store left side of product in temporary (${storageSpecToString(leftSideDestination)})`,
                    },
                    ...storeLeft,
                    {
                        kind: 'comment',
                        why: `Store right side of product in destination (${storageSpecToString(
                            rightSideDestination
                        )})`,
                    },
                    ...storeRight,
                    {
                        kind: 'multiply',
                        lhs: leftSideDestination,
                        rhs: rightSideDestination,
                        destination: destination,
                        why: 'Evaluate product',
                    },
                ]
            );
        }
        default:
            throw debug('todo');
    }
};

export const constructFunction = (
    f: Function,
    globalDeclarations,
    stringLiterals,
    firstTemporary: StorageSpec,
    nextTemporary,
    makeLabel
): RegisterTransferLanguageFunction => {
    // Statments are either assign or return right now, so we need one register for each statement, minus the return statement.
    const scratchRegisterCount = f.temporaryCount + f.statements.length - 1;

    const argumentRegisters: StorageSpec[] = ['functionArgument1', 'functionArgument2', 'functionArgument3'];
    if (f.parameters.length > 3) throw debug('todo'); // Don't want to deal with this yet.
    if (argumentRegisters.length < 3) throw debug('todo');
    const registerAssignment: { [key: string]: StorageSpec } = {};
    f.parameters.forEach((parameter, index) => {
        registerAssignment[parameter.name] = argumentRegisters[index];
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
            const compiledProgram = astToRegisterTransferLanguage(
                {
                    ast: statement,
                    registerAssignment,
                    destination: 'functionResult',
                    currentTemporary,
                    globalDeclarations,
                    stringLiterals,
                },
                nextTemporary,
                makeLabel
            );
            const freeLocals = f.variables
                // TODO: Make a better memory model for frees.
                .filter(s => s.location === 'Stack')
                .filter(s => s.type.name == 'String')
                .map(s => {
                    const memoryForVariable: StorageSpec = registerAssignment[s.name];
                    if (typeof memoryForVariable == 'string') throw debug('special register not valid here');
                    if (memoryForVariable.type !== 'register') throw debug('todo');
                    return [
                        { kind: 'move', from: memoryForVariable.destination, to: argumentRegisters[0] },
                        { kind: 'callByName', function: 'my_free', why: 'Free Stack String at end of scope' },
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
    return { name: f.name, numRegistersToSave: scratchRegisterCount, instructions: functionCode, isMain: false };
};
