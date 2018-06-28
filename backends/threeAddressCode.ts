import * as Ast from '../ast.js';
import flatten from '../util/list/flatten.js';
import { builtinFunctions } from '../frontend.js';
import { isEqual } from 'lodash';
import debug from '../util/debug.js';
import {
    CompiledExpression,
    compileExpression,
    stringLiteralName,
    saveRegistersCode,
    restoreRegistersCode,
    RegisterDescription,
} from '../backend-utils.js';
import { Register, toString as registerToString } from '../register.js';
import { Function, VariableDeclaration, StringLiteralData } from '../api.js';

type SyscallName = 'printInt' | 'print' | 'sbrk' | 'mmap' | 'exit';

export type ThreeAddressStatement = { why: string } & (
    | { kind: 'comment' }
    | { kind: 'syscall'; name: SyscallName; arguments: (Register | number)[]; destination: Register | undefined }
    | { kind: 'move'; from: Register; to: Register }
    | { kind: 'loadImmediate'; value: number; destination: Register }
    | { kind: 'addImmediate'; register: Register; amount: number }
    | { kind: 'subtract'; lhs: Register; rhs: Register; destination: Register }
    | { kind: 'add'; lhs: Register; rhs: Register; destination: Register }
    | { kind: 'multiply'; lhs: Register; rhs: Register; destination: Register }
    | { kind: 'increment'; register: Register }
    | { kind: 'label'; name: string }
    | { kind: 'functionLabel'; name: string }
    | { kind: 'goto'; label: string }
    | { kind: 'gotoIfEqual'; lhs: Register; rhs: Register; label: string }
    | { kind: 'gotoIfNotEqual'; lhs: Register; rhs: Register; label: string }
    | { kind: 'gotoIfZero'; register: Register; label: string }
    | { kind: 'gotoIfGreater'; lhs: Register; rhs: Register; label: string }
    | { kind: 'storeGlobal'; from: Register; to: string }
    | { kind: 'loadGlobal'; from: string; to: Register }
    | { kind: 'storeMemory'; from: Register; address: Register; offset: number }
    | { kind: 'storeMemoryByte'; address: Register; contents: Register }
    | { kind: 'storeZeroToMemory'; address: Register; offset: number }
    | { kind: 'loadMemory'; from: Register; to: Register; offset: number }
    | { kind: 'loadMemoryByte'; address: Register; to: Register }
    | { kind: 'loadSymbolAddress'; to: Register; symbolName: string }
    | { kind: 'callByName'; function: string }
    | { kind: 'callByRegister'; function: Register }
    | { kind: 'returnToCaller' });

export type ThreeAddressCode = ThreeAddressStatement[];

export type ThreeAddressFunction = {
    instructions: ThreeAddressCode;
    name: string;
    isMain: boolean;
};

export type TargetThreeAddressStatement<TargetRegister> = { why: string } & (
    | { kind: 'comment' }
    | { kind: 'syscall' }
    | { kind: 'move'; from: TargetRegister; to: TargetRegister }
    | { kind: 'loadImmediate'; value: number; destination: TargetRegister }
    | { kind: 'addImmediate'; register: TargetRegister; amount: number }
    | { kind: 'subtract'; lhs: TargetRegister; rhs: TargetRegister; destination: TargetRegister }
    | { kind: 'add'; lhs: TargetRegister; rhs: TargetRegister; destination: TargetRegister }
    | { kind: 'multiply'; lhs: TargetRegister; rhs: TargetRegister; destination: TargetRegister }
    | { kind: 'increment'; register: TargetRegister }
    | { kind: 'label'; name: string }
    | { kind: 'functionLabel'; name: string }
    | { kind: 'goto'; label: string }
    | { kind: 'gotoIfEqual'; lhs: TargetRegister; rhs: TargetRegister; label: string }
    | { kind: 'gotoIfNotEqual'; lhs: TargetRegister; rhs: TargetRegister; label: string }
    | { kind: 'gotoIfZero'; register: TargetRegister; label: string }
    | { kind: 'gotoIfGreater'; lhs: TargetRegister; rhs: TargetRegister; label: string }
    | { kind: 'storeGlobal'; from: TargetRegister; to: string }
    | { kind: 'loadGlobal'; from: string; to: TargetRegister }
    | { kind: 'storeMemory'; from: TargetRegister; address: TargetRegister; offset: number }
    | { kind: 'storeMemoryByte'; address: TargetRegister; contents: TargetRegister }
    | { kind: 'storeZeroToMemory'; address: TargetRegister; offset: number }
    | { kind: 'loadMemory'; from: TargetRegister; to: TargetRegister; offset: number }
    | { kind: 'loadMemoryByte'; address: TargetRegister; to: TargetRegister }
    | { kind: 'loadSymbolAddress'; to: TargetRegister; symbolName: string }
    | { kind: 'callByName'; function: string }
    | { kind: 'callByRegister'; function: TargetRegister }
    | { kind: 'returnToCaller' }
    | { kind: 'push'; register: TargetRegister }
    | { kind: 'pop'; register: TargetRegister });

const toStringWithoutComment = (rtx: ThreeAddressStatement): string => {
    switch (rtx.kind) {
        case 'comment':
            return ``;
        case 'syscall':
            return 'syscall';
        case 'move':
            return `${registerToString(rtx.to)} = ${registerToString(rtx.from)}`;
        case 'loadImmediate':
            return `${registerToString(rtx.destination)} = ${rtx.value}`;
        case 'addImmediate':
            return `${registerToString(rtx.register)} += ${rtx.amount}`;
        case 'subtract':
            return `${registerToString(rtx.destination)} = ${registerToString(rtx.lhs)} - ${registerToString(rtx.rhs)}`;
        case 'add':
            return `${registerToString(rtx.destination)} = ${registerToString(rtx.lhs)} + ${registerToString(rtx.rhs)}`;
        case 'multiply':
            return `${registerToString(rtx.destination)} = ${registerToString(rtx.lhs)} * ${registerToString(rtx.rhs)}`;
        case 'increment':
            return `${registerToString(rtx.register)}++`;
        case 'label':
        case 'functionLabel':
            return `${rtx.name}:`;
        case 'goto':
            return `goto ${rtx.label}`;
        case 'gotoIfEqual':
            return `goto ${rtx.label} if ${registerToString(rtx.lhs)} == ${registerToString(rtx.rhs)}`;
        case 'gotoIfNotEqual':
            return `goto ${rtx.label} if ${registerToString(rtx.lhs)} != ${registerToString(rtx.rhs)}`;
        case 'gotoIfZero':
            return `goto ${rtx.label} if ${registerToString(rtx.register)} == 0`;
        case 'gotoIfGreater':
            return `goto ${rtx.label} if ${registerToString(rtx.lhs)} > ${registerToString(rtx.rhs)}`;
        case 'storeGlobal':
            return `*${rtx.to} = ${registerToString(rtx.from)}`;
        case 'loadGlobal':
            return `${registerToString(rtx.to)} = &${rtx.from}`;
        case 'storeMemory':
            return `*(${registerToString(rtx.address)} + ${rtx.offset}) = ${registerToString(rtx.from)}`;
        case 'storeMemoryByte':
            return `*${registerToString(rtx.address)} = ${registerToString(rtx.contents)}`;
        case 'storeZeroToMemory':
            return `*${registerToString(rtx.address)} = 0`;
        case 'loadMemory':
            return `${registerToString(rtx.to)} = *(${registerToString(rtx.from)} + ${rtx.offset})`;
        case 'loadMemoryByte':
            return `${registerToString(rtx.to)} = *${registerToString(rtx.address)}`;
        case 'loadSymbolAddress':
            return `${registerToString(rtx.to)} = &${rtx.symbolName}`;
        case 'callByRegister':
            return `${registerToString(rtx.function)}()`;
        case 'callByName':
            return `${rtx.function}()`;
        case 'returnToCaller':
            return `return`;
        default:
            throw debug('Unrecognized RTX kind in toString');
    }
};

export const toString = (rtx: ThreeAddressStatement): string => `${toStringWithoutComment(rtx)} # ${rtx.why}`;

export type BackendOptions = {
    ast: Ast.Ast;
    destination: Register;
    globalDeclarations: VariableDeclaration[];
    stringLiterals: StringLiteralData[];
    variablesInScope: { [key: string]: Register };
    makeTemporary: (name: string) => Register;
    makeLabel: (name: string) => string;
};

export const astToThreeAddressCode = (input: BackendOptions): CompiledExpression<ThreeAddressStatement> => {
    const { ast, variablesInScope, destination, globalDeclarations, stringLiterals, makeTemporary, makeLabel } = input;
    const recurse = newInput => astToThreeAddressCode({ ...input, ...newInput });
    switch (ast.kind) {
        case 'number':
            return compileExpression<ThreeAddressStatement>([], ([]) => [
                { kind: 'loadImmediate', value: ast.value, destination: destination, why: 'Load number literal' },
            ]);
        case 'booleanLiteral':
            return compileExpression<ThreeAddressStatement>([], ([]) => [
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
            return compileExpression<ThreeAddressStatement>([], ([]) => [
                {
                    kind: 'loadSymbolAddress',
                    symbolName: stringLiteralName(stringLiteralData),
                    to: destination,
                    why: 'Load string literal address into register',
                },
            ]);
        }
        case 'returnStatement':
            const result = makeTemporary('result');
            const subExpression = recurse({
                ast: ast.expression,
                destination: result,
            });
            return compileExpression<ThreeAddressStatement>([subExpression], ([e1]) => [
                ...e1,
                {
                    kind: 'move',
                    from: result,
                    to: 'functionResult',
                    why: 'Return previous expression',
                },
            ]);
        case 'subtraction': {
            const lhs = makeTemporary('addition_lhs');
            const rhs = makeTemporary('addition_rhs');
            const computeLhs = recurse({ ast: ast.lhs, destination: lhs });
            const computeRhs = recurse({ ast: ast.rhs, destination: rhs });

            return compileExpression<ThreeAddressStatement>([computeLhs, computeRhs], ([storeLeft, storeRight]) => [
                ...storeLeft,
                ...storeRight,
                {
                    kind: 'subtract',
                    lhs,
                    rhs,
                    destination,
                    why: 'Evaluate subtraction',
                },
            ]);
        }
        case 'addition': {
            const lhs = makeTemporary('addition_lhs');
            const rhs = makeTemporary('addition_rhs');
            const computeLhs = recurse({ ast: ast.lhs, destination: lhs });
            const computeRhs = recurse({ ast: ast.rhs, destination: rhs });

            return compileExpression<ThreeAddressStatement>([computeLhs, computeRhs], ([storeLeft, storeRight]) => [
                ...storeLeft,
                ...storeRight,
                {
                    kind: 'add',
                    lhs,
                    rhs,
                    destination,
                    why: 'Evaluate addition',
                },
            ]);
        }
        case 'ternary': {
            const condition = makeTemporary('ternary_condition');
            const falseBranchLabel = makeLabel('falseBranch');
            const endOfTernaryLabel = makeLabel('endOfTernary');
            const computeCondition = recurse({ ast: ast.condition, destination: condition });
            const ifTrueExpression = recurse({ ast: ast.ifTrue });
            const ifFalseExpression = recurse({ ast: ast.ifFalse });
            return compileExpression<ThreeAddressStatement>(
                [computeCondition, ifTrueExpression, ifFalseExpression],
                ([e1, e2, e3]) => [
                    ...e1,
                    {
                        kind: 'gotoIfZero',
                        register: condition,
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
            return compileExpression<ThreeAddressStatement>([], ([]) => [
                {
                    kind: 'loadSymbolAddress',
                    to: destination,
                    symbolName: ast.deanonymizedName,
                    why: 'Loading function into register',
                },
            ]);
        case 'callExpression': {
            const functionName = ast.name;
            let callInstructions: (string | ThreeAddressStatement)[] = [];
            if (builtinFunctions.map(b => b.name).includes(functionName)) {
                const functionPointer = makeTemporary('function_pointer');
                callInstructions = [
                    {
                        kind: 'loadSymbolAddress',
                        symbolName: functionName,
                        to: functionPointer,
                        why: 'Load runtime function',
                    },
                    { kind: 'callByRegister', function: functionPointer, why: 'Call runtime function' },
                ];
            } else if (globalDeclarations.some(declaration => declaration.name === functionName)) {
                const functionPointer = makeTemporary('function_pointer');
                callInstructions = [
                    {
                        kind: 'loadGlobal',
                        from: functionName,
                        to: functionPointer,
                        why: 'Load global function pointer',
                    },
                    { kind: 'callByRegister', function: functionPointer, why: 'Call global function' },
                ];
            } else if (functionName in variablesInScope) {
                callInstructions = [
                    {
                        kind: 'callByRegister',
                        function: variablesInScope[functionName],
                        why: 'Call register function',
                    },
                ];
            } else {
                debug('todo');
            }

            const computeArgumentsMips = ast.arguments.map((argument, index) => {
                let register: Register;
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
                });
            });

            const argumentComputerToMips = (argumentComputer, index) => [
                { kind: 'comment', why: `Put argument ${index} in register` },
                ...argumentComputer,
            ];

            return compileExpression<ThreeAddressStatement>(computeArgumentsMips, argumentComputers => [
                ...flatten(argumentComputers.map(argumentComputerToMips)),
                { kind: 'comment', why: `call ${functionName}` },
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
                return compileExpression<ThreeAddressStatement>(
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
                const lhs = makeTemporary('equality_lhs');
                const rhs = makeTemporary('equality_rhs');
                const storeLeftInstructions = recurse({ ast: ast.lhs, destination: lhs });
                const storeRightInstructions = recurse({ ast: ast.rhs, destination: rhs });

                const equalLabel = makeLabel('equal');
                const endOfConditionLabel = makeLabel('endOfCondition');

                return compileExpression<ThreeAddressStatement>(
                    [storeLeftInstructions, storeRightInstructions],
                    ([storeLeft, storeRight]) => [
                        ...storeLeft,
                        ...storeRight,
                        {
                            kind: 'gotoIfEqual',
                            lhs: lhs,
                            rhs: rhs,
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
            const lhs: string = ast.destination;
            if (globalDeclarations.some(declaration => declaration.name === lhs)) {
                const rhs = makeTemporary('assignment_rhs');
                const computeRhs = recurse({
                    ast: ast.expression,
                    destination: rhs,
                });
                const declaration = globalDeclarations.find(declaration => declaration.name === lhs);
                if (!declaration) throw debug('todo');
                switch (declaration.type.name) {
                    case 'Function':
                    case 'Integer':
                        return compileExpression<ThreeAddressStatement>([computeRhs], ([e1]) => [
                            ...e1,
                            {
                                kind: 'storeGlobal',
                                from: rhs,
                                to: lhs,
                                why: `Put ${declaration.type.name} into global`,
                            },
                        ]);
                    case 'String':
                        return compileExpression<ThreeAddressStatement>([computeRhs], ([e1]) => [
                            ...e1,
                            {
                                kind: 'move',
                                to: 'functionArgument1',
                                from: rhs,
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
                                from: rhs,
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
                                to: lhs,
                                why: 'Store into global',
                            },
                        ]);
                    default:
                        throw debug('todo');
                }
            } else if (lhs in variablesInScope) {
                return recurse({
                    ast: ast.expression,
                    destination: variablesInScope[lhs],
                });
            } else {
                throw debug('Declared variable was neither global nor local');
            }
        }
        case 'reassignment': {
            const lhs: string = ast.destination;
            if (globalDeclarations.some(declaration => declaration.name === lhs)) {
                const reassignmentRhs = makeTemporary('reassignment_rhs');
                const rhs: CompiledExpression<ThreeAddressStatement> = recurse({
                    ast: ast.expression,
                    destination: reassignmentRhs,
                });
                const declaration = globalDeclarations.find(declaration => declaration.name === lhs);
                if (!declaration) throw debug('todo');
                switch (declaration.type.name) {
                    case 'Function':
                    case 'Integer':
                        return compileExpression<ThreeAddressStatement>([rhs], ([e1]) => [
                            ...e1,
                            {
                                kind: 'storeGlobal',
                                from: reassignmentRhs,
                                to: lhs,
                                why: 'Store into global',
                            },
                        ]);
                    case 'String':
                        const oldData = makeTemporary('old_data');
                        const prepAndCleanup = {
                            prepare: [
                                {
                                    kind: 'loadGlobal',
                                    to: oldData,
                                    from: lhs,
                                    why: 'Save global for freeing after assignment',
                                } as ThreeAddressStatement,
                            ],
                            execute: [],
                            cleanup: [
                                {
                                    kind: 'move',
                                    from: oldData,
                                    to: 'functionArgument1',
                                    why: 'Move global to argument 1 of free',
                                },
                                {
                                    kind: 'callByName',
                                    function: 'my_free',
                                    why: 'Free string that is no longer accessible',
                                },
                            ] as ThreeAddressStatement[],
                        };
                        return compileExpression<ThreeAddressStatement>([rhs, prepAndCleanup], ([e1, _]) => [
                            ...e1,
                            {
                                kind: 'move',
                                from: reassignmentRhs,
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
                                to: lhs,
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
                                from: reassignmentRhs,
                                to: 'functionArgument1',
                                why: 'move destination to argument 1 of string_copy',
                            },
                            { kind: 'callByName', function: 'string_copy', why: 'Copy new string to destination' },
                        ]);
                    default:
                        throw debug('todo');
                }
            } else if (lhs in variablesInScope) {
                return recurse({
                    ast: ast.expression,
                    destination: variablesInScope[lhs],
                });
            } else {
                throw debug('Reassigned variable was neither global nor local');
            }
        }
        case 'concatenation': {
            const leftSideDestination = makeTemporary('concat_lhs');
            const rightSideDestination = makeTemporary('concat_rhs');
            const newStringLengthTemporary = makeTemporary('concat_result_length');
            const mallocResultTemporary = makeTemporary('concat_destination_storage');

            const storeLeftInstructions = recurse({
                ast: ast.lhs,
                destination: leftSideDestination,
            });
            const storeRightInstructions = recurse({
                ast: ast.rhs,
                destination: rightSideDestination,
            });
            const cleanup: CompiledExpression<ThreeAddressStatement> = {
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
            return compileExpression<ThreeAddressStatement>(
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
                return compileExpression<ThreeAddressStatement>([], ([]) => [
                    {
                        kind: 'loadGlobal',
                        to: destination,
                        from: identifierName,
                        why: `Load ${identifierName} from global into register`,
                    },
                ]);
            }
            const identifierRegister = variablesInScope[identifierName];
            return compileExpression<ThreeAddressStatement>([], ([]) => [
                {
                    kind: 'move',
                    from: identifierRegister,
                    to: destination,
                    why: `Move from ${identifierName} into destination`,
                },
            ]);
        }
        case 'product': {
            const leftSideDestination = makeTemporary('product_lhs');
            const rightSideDestination = makeTemporary('product_rhs');

            const storeLeftInstructions = recurse({
                ast: ast.lhs,
                destination: leftSideDestination,
            });
            const storeRightInstructions = recurse({
                ast: ast.rhs,
                destination: rightSideDestination,
            });
            return compileExpression<ThreeAddressStatement>(
                [storeLeftInstructions, storeRightInstructions],
                ([storeLeft, storeRight]) => [
                    {
                        kind: 'comment',
                        why: `Store left side of product in temporary (${registerToString(leftSideDestination)})`,
                    },
                    ...storeLeft,
                    {
                        kind: 'comment',
                        why: `Store right side of product in destination (${registerToString(rightSideDestination)})`,
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
    makeLabel,
    makeTemporary
): ThreeAddressFunction => {
    const argumentRegisters: Register[] = ['functionArgument1', 'functionArgument2', 'functionArgument3'];
    if (f.parameters.length > 3) throw debug('todo'); // Don't want to deal with this yet.
    if (argumentRegisters.length < 3) throw debug('todo');
    const variablesInScope: { [key: string]: Register } = {};
    f.parameters.forEach((parameter, index) => {
        variablesInScope[parameter.name] = argumentRegisters[index];
    });

    f.statements.forEach(statement => {
        if (statement.kind === 'typedDeclarationAssignment') {
            variablesInScope[statement.destination] = makeTemporary(`local_${statement.destination}`);
        }
    });

    const functionCode = flatten(
        f.statements.map(statement => {
            const compiledProgram = astToThreeAddressCode({
                ast: statement,
                variablesInScope,
                destination: 'functionResult',
                globalDeclarations,
                stringLiterals,
                makeTemporary,
                makeLabel,
            });
            const freeLocals = f.variables
                // TODO: Make a better memory model for frees.
                .filter(s => s.location === 'Stack')
                .filter(s => s.type.name == 'String')
                .map(s => {
                    const variable: Register = variablesInScope[s.name];
                    return [
                        { kind: 'move', from: variable, to: 'functionArgument1' },
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
    return { name: f.name, instructions: functionCode, isMain: false };
};

export const threeAddressCodeToTarget = <TargetRegister>(
    tas: ThreeAddressStatement,
    syscallNumbers,
    registerTypes: RegisterDescription<TargetRegister>,
    getRegister: (r: Register) => TargetRegister
): TargetThreeAddressStatement<TargetRegister>[] => {
    switch (tas.kind) {
        case 'comment':
        case 'functionLabel':
        case 'returnToCaller':
        case 'callByName':
        case 'goto':
        case 'label':
            return [tas];
        case 'syscall':
            // TOOD: DRY with syscall impl in mips
            // TODO: find a way to make this less opaque to register allocation so less spilling is necessary
            if (tas.arguments.length > registerTypes.syscallArgument.length)
                throw debug(`this backend only supports ${registerTypes.syscallArgument.length} syscall args`);
            const registersToSave: TargetRegister[] = [];

            if (tas.destination && getRegister(tas.destination) != registerTypes.syscallSelectAndResult) {
                registersToSave.push(registerTypes.syscallSelectAndResult);
            }
            tas.arguments.forEach((_, index) => {
                const argRegister = registerTypes.syscallArgument[index];
                if (tas.destination && getRegister(tas.destination) == argRegister) {
                    return;
                }
                registersToSave.push(argRegister);
            });
            // TODO: Allow a "replacements" feature, to convert complex/unsupported RTL instructions into supported ones
            const result: TargetThreeAddressStatement<TargetRegister>[] = [
                ...registersToSave.map(r => ({
                    kind: 'push' as 'push',
                    register: r,
                    why: 'save registers',
                })),
                ...tas.arguments.map(
                    (arg, index) =>
                        typeof arg == 'number'
                            ? {
                                  kind: 'loadImmediate' as 'loadImmediate',
                                  value: arg,
                                  destination: registerTypes.syscallArgument[index],
                                  why: 'syscallArg = immediate',
                              }
                            : {
                                  kind: 'move' as 'move',
                                  from: getRegister(arg),
                                  to: registerTypes.syscallArgument[index],
                                  why: 'syscallArg = register',
                              }
                ),
                {
                    kind: 'loadImmediate',
                    value: syscallNumbers[tas.name],
                    destination: registerTypes.syscallSelectAndResult,
                    why: 'syscall select',
                },
                { kind: 'syscall', why: 'syscall' },
                ...(tas.destination
                    ? ([
                          {
                              kind: 'move',
                              from: registerTypes.syscallSelectAndResult,
                              to: getRegister(tas.destination),
                              why: 'destination = syscallResult',
                          },
                      ] as TargetThreeAddressStatement<TargetRegister>[])
                    : []),
                ...registersToSave
                    .reverse()
                    .map(r => ({ kind: 'pop' as 'pop', register: r, why: 'restore registers' })),
            ];
            return result;
        case 'move':
            return [{ ...tas, to: getRegister(tas.to), from: getRegister(tas.from) }];
        case 'loadImmediate':
            if (!getRegister(tas.destination)) debugger;
            return [{ ...tas, destination: getRegister(tas.destination) }];
        case 'add':
        case 'subtract':
        case 'multiply': {
            return [
                {
                    ...tas,
                    lhs: getRegister(tas.lhs),
                    rhs: getRegister(tas.rhs),
                    destination: getRegister(tas.destination),
                },
            ];
        }
        case 'addImmediate':
        case 'increment':
        case 'gotoIfZero':
            return [{ ...tas, register: getRegister(tas.register) }];
        case 'gotoIfEqual':
        case 'gotoIfNotEqual':
        case 'gotoIfGreater':
            return [{ ...tas, lhs: getRegister(tas.lhs), rhs: getRegister(tas.rhs) }];
        case 'loadSymbolAddress':
        case 'loadGlobal':
            return [{ ...tas, to: getRegister(tas.to) }];
        case 'storeGlobal':
            return [{ ...tas, from: getRegister(tas.from) }];
        case 'loadMemory':
            return [{ ...tas, to: getRegister(tas.to), from: getRegister(tas.from) }];
        case 'loadMemoryByte':
            return [{ ...tas, to: getRegister(tas.to), address: getRegister(tas.address) }];
        case 'storeMemory':
            return [{ ...tas, from: getRegister(tas.from), address: getRegister(tas.address) }];
        case 'storeZeroToMemory':
            return [{ ...tas, address: getRegister(tas.address) }];
        case 'storeMemoryByte':
            return [{ ...tas, address: getRegister(tas.address), contents: getRegister(tas.contents) }];
        case 'callByRegister':
            return [{ ...tas, function: getRegister(tas.function) }];
        default:
            throw debug(`${(tas as any).kind} unhandled in threeAddressCodeToTarget`);
    }
};
