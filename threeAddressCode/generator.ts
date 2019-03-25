import {
    length,
    intFromString,
    stringCopy,
    verifyNoLeaks,
    stringConcatenateRuntimeFunction,
    stringEqualityRuntimeFunction,
    myFreeRuntimeFunction,
    RuntimeFunctionGenerator,
} from './runtime.js';
import idAppender from '../util/idAppender.js';
import * as Ast from '../ast.js';
import flatten from '../util/list/flatten.js';
import sum from '../util/list/sum.js';
import { builtinFunctions, Type, TypeDeclaration, resolve, typeSize } from '../types.js';
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
import { Statement } from './statement.js';

export type ThreeAddressFunction = {
    instructions: Statement[];
    spills: number;
    name: string;
};

export type TargetThreeAddressStatement<TargetRegister> = { why: string } & (
    | { kind: 'comment' }
    // Arithmetic
    | { kind: 'move'; from: TargetRegister; to: TargetRegister }
    | { kind: 'loadImmediate'; value: number; destination: TargetRegister }
    | { kind: 'addImmediate'; register: TargetRegister; amount: number }
    | { kind: 'subtract'; lhs: TargetRegister; rhs: TargetRegister; destination: TargetRegister }
    | { kind: 'add'; lhs: TargetRegister; rhs: TargetRegister; destination: TargetRegister }
    | { kind: 'multiply'; lhs: TargetRegister; rhs: TargetRegister; destination: TargetRegister }
    | { kind: 'increment'; register: TargetRegister }
    // Labels
    | { kind: 'label'; name: string }
    | { kind: 'functionLabel'; name: string }
    // Branches
    | { kind: 'goto'; label: string }
    | { kind: 'gotoIfEqual'; lhs: TargetRegister; rhs: TargetRegister; label: string }
    | { kind: 'gotoIfNotEqual'; lhs: TargetRegister; rhs: TargetRegister | number; label: string }
    | { kind: 'gotoIfZero'; register: TargetRegister; label: string }
    | { kind: 'gotoIfGreater'; lhs: TargetRegister; rhs: TargetRegister; label: string }
    // Memory Writes
    | { kind: 'storeGlobal'; from: TargetRegister; to: string }
    | { kind: 'storeMemory'; from: TargetRegister; address: TargetRegister; offset: number }
    | { kind: 'storeMemoryByte'; address: TargetRegister; contents: TargetRegister }
    | { kind: 'storeZeroToMemory'; address: TargetRegister; offset: number }
    // Memory Reads
    | { kind: 'loadGlobal'; from: string; to: TargetRegister }
    | { kind: 'loadMemory'; from: TargetRegister; to: TargetRegister; offset: number }
    | { kind: 'loadMemoryByte'; address: TargetRegister; to: TargetRegister }
    | { kind: 'loadSymbolAddress'; to: TargetRegister; symbolName: string }
    // Function calls
    | { kind: 'syscall' }
    | { kind: 'callByName'; function: string }
    | { kind: 'callByRegister'; function: TargetRegister }
    | { kind: 'returnToCaller' }
    // Stack Management
    | { kind: 'loadStackOffset'; register: TargetRegister; offset: number } // TODO: This should be fused with stackStore probably
    | { kind: 'stackStore'; register: TargetRegister; offset: number }
    | { kind: 'stackLoad'; register: TargetRegister; offset: number }
    | { kind: 'push'; register: TargetRegister }
    | { kind: 'pop'; register: TargetRegister });

export type GlobalInfo = { newName: string; originalDeclaration: VariableDeclaration };

export type BackendOptions = {
    ast: Ast.Ast;
    destination: Register;
    globalNameMap: { [key: string]: GlobalInfo };
    stringLiterals: StringLiteralData[];
    variablesInScope: { [key: string]: Register };
    makeTemporary: (name: string) => Register;
    makeLabel: (name: string) => string;
    types: TypeDeclaration[];
    targetInfo: TargetInfo;
};

export type TargetInfo = {
    alignment: number;
    bytesInWord: number;
    cleanupCode: Statement[];
    // These functions tend to have platform specific implementations. Put your platforms implementation here.
    mallocImpl: ThreeAddressFunction;
    printImpl: ThreeAddressFunction;
    readIntImpl: ThreeAddressFunction;
};

const memberOffset = (type: Type, memberName: string, targetInfo: TargetInfo): number => {
    if (type.kind != 'Product') throw debug('need a product here');
    const result = type.members.findIndex(m => m.name == memberName);
    if (result < 0) throw debug('coudnt find member');
    return result * targetInfo.alignment;
};

export const astToThreeAddressCode = (input: BackendOptions): CompiledExpression<Statement> => {
    const {
        ast,
        variablesInScope,
        destination,
        globalNameMap,
        stringLiterals,
        makeTemporary,
        makeLabel,
        types,
        targetInfo,
    } = input;
    const recurse = newInput => astToThreeAddressCode({ ...input, ...newInput });
    switch (ast.kind) {
        case 'number':
            return compileExpression<Statement>([], ([]) => [
                { kind: 'loadImmediate', value: ast.value, destination, why: 'Load number literal' },
            ]);
        case 'booleanLiteral':
            return compileExpression<Statement>([], ([]) => [
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
            return compileExpression<Statement>([], ([]) => [
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
            return compileExpression<Statement>([subExpression], ([e1]) => [
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

            return compileExpression<Statement>([computeLhs, computeRhs], ([storeLeft, storeRight]) => [
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

            return compileExpression<Statement>([computeLhs, computeRhs], ([storeLeft, storeRight]) => [
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
            return compileExpression<Statement>(
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
            return compileExpression<Statement>([], ([]) => [
                {
                    kind: 'loadSymbolAddress',
                    to: destination,
                    symbolName: ast.deanonymizedName,
                    why: 'Loading function into register',
                },
            ]);
        case 'callExpression': {
            const functionName = ast.name;
            let callInstructions: (string | Statement)[] = [];
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
            } else if (functionName in globalNameMap) {
                const functionPointer = makeTemporary('function_pointer');
                callInstructions = [
                    {
                        kind: 'loadGlobal',
                        from: globalNameMap[functionName].newName,
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

            return compileExpression<Statement>(computeArgumentsMips, argumentComputers => [
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
            if (ast.type.kind == 'String') {
                // Put left in s0 and right in s1 for passing to string equality function
                const storeLeftInstructions = recurse({
                    ast: ast.lhs,
                    destination: 'functionArgument1',
                });
                const storeRightInstructions = recurse({
                    ast: ast.rhs,
                    destination: 'functionArgument2',
                });
                return compileExpression<Statement>([storeLeftInstructions, storeRightInstructions], ([e1, e2]) => [
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
                ]);
            } else {
                const lhs = makeTemporary('equality_lhs');
                const rhs = makeTemporary('equality_rhs');
                const storeLeftInstructions = recurse({ ast: ast.lhs, destination: lhs });
                const storeRightInstructions = recurse({ ast: ast.rhs, destination: rhs });

                const equalLabel = makeLabel('equal');
                const endOfConditionLabel = makeLabel('endOfCondition');

                return compileExpression<Statement>(
                    [storeLeftInstructions, storeRightInstructions],
                    ([storeLeft, storeRight]) => [
                        ...storeLeft,
                        ...storeRight,
                        { kind: 'gotoIfEqual', lhs, rhs, label: equalLabel, why: 'Goto set 1 if equal' },
                        { kind: 'loadImmediate', value: 0, destination, why: 'Not equal, set 0' },
                        { kind: 'goto', label: endOfConditionLabel, why: 'And goto exit' },
                        { kind: 'label', name: equalLabel, why: 'Sides are equal' },
                        { kind: 'loadImmediate', value: 1, destination, why: 'Set 1' },
                        { kind: 'label', name: endOfConditionLabel, why: 'End of condition' },
                    ]
                );
            }
        }
        case 'typedDeclarationAssignment': {
            const lhs: string = ast.destination;
            if (lhs in globalNameMap) {
                const rhs = makeTemporary('assignment_rhs');
                const computeRhs = recurse({
                    ast: ast.expression,
                    destination: rhs,
                });
                const lhsInfo = globalNameMap[lhs];
                const lhsType = lhsInfo.originalDeclaration.type;
                switch (lhsType.kind) {
                    case 'Function':
                    case 'Integer':
                        return compileExpression<Statement>([computeRhs], ([e1]) => [
                            ...e1,
                            {
                                kind: 'storeGlobal',
                                from: rhs,
                                to: lhsInfo.newName,
                                why: `Put ${lhsType.kind} into global`,
                            },
                        ]);
                    case 'String':
                        return compileExpression<Statement>([computeRhs], ([e1]) => [
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
                                to: lhsInfo.newName,
                                why: 'Store into global',
                            },
                        ]);
                    case 'Product':
                        const lhsAddress = makeTemporary('lhsAddress');
                        const copyStructInstructions: Statement[] = [
                            {
                                kind: 'loadSymbolAddress',
                                to: lhsAddress,
                                symbolName: lhsInfo.newName,
                                why: 'Get address of global struct so we can write to it',
                            },
                            ...flatten(
                                lhsType.members.map((m, i) => {
                                    const offset = i * targetInfo.alignment; // TODO: Should add up sizes of preceeding members
                                    const memberTemporary = makeTemporary('member');
                                    return [
                                        {
                                            kind: 'loadMemory' as 'loadMemory',
                                            from: rhs,
                                            to: memberTemporary,
                                            offset,
                                            why: `load member from rhs ${m.name}`,
                                        },
                                        {
                                            kind: 'storeMemory' as 'storeMemory',
                                            from: memberTemporary,
                                            address: lhsAddress,
                                            offset,
                                            why: `store member to lhs ${m.name}`,
                                        },
                                    ];
                                })
                            ),
                        ];
                        return compileExpression<Statement>([computeRhs], ([e1]) => [
                            ...e1,
                            {
                                kind: 'stackAllocateAndStorePointer',
                                bytes: typeSize(targetInfo, ast.type, types),
                                register: destination,
                                why: 'make stack space for lhs',
                            },
                            ...copyStructInstructions,
                        ]);
                    case 'List':
                        const remainingCount = makeTemporary('remainingCount');
                        const copyLoop = makeLabel('copyLoop');
                        const temp = makeTemporary('temp');
                        const currentIndex = makeTemporary('currentIndex');
                        return compileExpression<Statement>([computeRhs], ([e1]) => [
                            ...e1,
                            {
                                kind: 'loadMemory',
                                from: rhs,
                                to: remainingCount,
                                offset: 0,
                                why: 'Get length of list',
                            },
                            {
                                kind: 'addImmediate',
                                register: remainingCount,
                                amount: 1,
                                why: 'add storage for length of list',
                            },
                            {
                                kind: 'move',
                                from: remainingCount,
                                to: 'functionArgument1',
                                why: 'prepare to malloc',
                            },
                            {
                                kind: 'callByName',
                                function: 'malloc',
                                why: 'malloc',
                            },
                            {
                                kind: 'move',
                                from: 'functionResult',
                                to: destination,
                                why: 'destination pointer',
                            },
                            {
                                kind: 'move',
                                from: 'functionResult',
                                to: currentIndex,
                                why: '',
                            },
                            {
                                kind: 'label',
                                name: copyLoop,
                                why: 'copy loop',
                            },
                            {
                                kind: 'loadMemory',
                                from: rhs,
                                to: temp,
                                offset: 0,
                                why: 'copy a byte',
                            },
                            {
                                kind: 'storeMemory',
                                from: temp,
                                address: currentIndex,
                                offset: 0,
                                why: 'finish copying',
                            },
                            {
                                kind: 'addImmediate',
                                register: remainingCount,
                                amount: -1,
                                why: 'copied a byte',
                            },
                            {
                                kind: 'addImmediate',
                                register: currentIndex,
                                amount: 1,
                                why: 'next byte to copy',
                            },
                            {
                                kind: 'gotoIfNotEqual',
                                why: 'not done yet',
                                lhs: remainingCount,
                                rhs: 0,
                                label: copyLoop,
                            },
                        ]);
                    default:
                        const unhandled = lhsInfo.originalDeclaration.type.kind;
                        throw debug(`${unhandled} unhandled in typedDeclarationAssignment`);
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
            if (lhs in globalNameMap) {
                const reassignmentRhs = makeTemporary('reassignment_rhs');
                const rhs: CompiledExpression<Statement> = recurse({
                    ast: ast.expression,
                    destination: reassignmentRhs,
                });
                const declaration = globalNameMap[lhs];
                switch (declaration.originalDeclaration.type.kind) {
                    case 'Function':
                    case 'Integer':
                        return compileExpression<Statement>([rhs], ([e1]) => [
                            ...e1,
                            {
                                kind: 'storeGlobal',
                                from: reassignmentRhs,
                                to: declaration.newName,
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
                                    from: declaration.newName,
                                    why: 'Save global for freeing after assignment',
                                } as Statement,
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
                            ] as Statement[],
                        };
                        return compileExpression<Statement>([rhs, prepAndCleanup], ([e1, _]) => [
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
                                to: declaration.newName,
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
            const cleanup: CompiledExpression<Statement> = {
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
            return compileExpression<Statement>(
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
            if (identifierName in globalNameMap) {
                const info = globalNameMap[identifierName];
                if (info.originalDeclaration.type.kind == 'Product') {
                    return compileExpression<Statement>([], ([]) => [
                        {
                            kind: 'loadSymbolAddress',
                            to: destination,
                            symbolName: info.newName,
                            why: `Load address of global non-scalar ${identifierName}`,
                        },
                    ]);
                } else {
                    return compileExpression<Statement>([], ([]) => [
                        {
                            kind: 'loadGlobal',
                            to: destination,
                            from: info.newName,
                            why: `Load ${identifierName} from global into register`,
                        },
                    ]);
                }
            }
            const identifierRegister = variablesInScope[identifierName];
            return compileExpression<Statement>([], ([]) => [
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
            return compileExpression<Statement>(
                [storeLeftInstructions, storeRightInstructions],
                ([storeLeft, storeRight]) => [
                    ...storeLeft,
                    ...storeRight,
                    {
                        kind: 'multiply',
                        lhs: leftSideDestination,
                        rhs: rightSideDestination,
                        destination,
                        why: 'Evaluate product',
                    },
                ]
            );
        }
        case 'objectLiteral': {
            const createObjectMembers: CompiledExpression<Statement>[] = ast.members.map((m, index) => {
                const memberTemporary = makeTemporary(`member_${m.name}`);
                return compileExpression(
                    [recurse({ ast: m.expression, destination: memberTemporary })],
                    ([storeMemberInstructions]) => [
                        ...storeMemberInstructions,
                        {
                            kind: 'storeMemory' as 'storeMemory',
                            from: memberTemporary,
                            address: destination,
                            offset: index * targetInfo.alignment, // TODO: proper alignment and offsets
                            why: `object literal member ${m.name}`,
                        },
                    ]
                );
            });
            return compileExpression<Statement>(createObjectMembers, members => [
                {
                    kind: 'stackAllocateAndStorePointer',
                    bytes: typeSize(targetInfo, ast.type, types),
                    register: destination,
                    why: 'Make space for object literal',
                },
                ...flatten(members),
            ]);
        }
        case 'listLiteral': {
            const bytesToAllocate = makeTemporary('bytesToAllocate');
            const dataPointer = makeTemporary('dataPointer');
            const createItems: CompiledExpression<Statement>[] = ast.items.map((m, index) => {
                const itemTemporary = makeTemporary(`item_${index}`);
                return compileExpression(
                    [recurse({ ast: m, destination: itemTemporary })],
                    ([makeItemInstructions]) => [
                        ...makeItemInstructions,
                        {
                            kind: 'storeMemory' as 'storeMemory',
                            from: itemTemporary,
                            address: dataPointer,
                            offset: index * targetInfo.alignment, // TODO: proper alignment for lists of larger-than-word types.
                            why: 'Store this item in the list',
                        },
                    ]
                );
            });
            return compileExpression<Statement>(createItems, create => [
                {
                    kind: 'loadImmediate' as 'loadImmediate',
                    value: ast.items.length * typeSize(targetInfo, ast.type, types),
                    destination: 'functionArgument1',
                    why: 'num bytes for list',
                },
                {
                    kind: 'addImmediate',
                    register: 'functionArgument1',
                    amount: targetInfo.bytesInWord,
                    why: 'add room for length',
                },
                { kind: 'callByName', function: 'my_malloc', why: 'Allocate that much space' },
                { kind: 'move', from: 'functionResult', to: dataPointer, why: 'save memory for pointer' },
                { kind: 'loadImmediate', value: ast.items.length, destination: destination, why: 'store size' },
                { kind: 'loadImmediate', value: ast.items.length, destination: destination, why: 'store size' },
                ...flatten(create),
                { kind: 'move', from: dataPointer, to: 'functionArgument1', why: 'prepare to free temp list' },
                { kind: 'callByName', function: 'my_free', why: 'free temporary list' },
            ]);
        }
        case 'memberAccess': {
            const lhs = makeTemporary('object_to_access');
            const lhsInstructions = recurse({ ast: ast.lhs, destination: lhs });
            let type = ast.lhsType;
            if (type.kind == 'NameRef') {
                const resolvedType = resolve(type, types);
                if (resolvedType) {
                    type = resolvedType;
                } else {
                    throw debug('invalid nameref');
                }
            }
            return compileExpression<Statement>([lhsInstructions], ([makeLhs]) => [
                ...makeLhs,
                {
                    kind: 'loadMemory',
                    from: lhs,
                    to: destination,
                    offset: memberOffset(type, ast.rhs, targetInfo),
                    why: 'Read the memory',
                },
            ]);
        }
        case 'indexAccess': {
            const index = makeTemporary('index');
            const indexInstructions = recurse({ ast: ast.index, destination: index });
            const accessed = makeTemporary('accessed');
            const accessedInstructions = recurse({ ast: ast.accessed, destination: accessed });
            const length = makeTemporary('length');
            const outOfRange = makeLabel('outOfRange');
            const itemAddress = makeTemporary('itemAddress');
            return compileExpression<Statement>(
                [indexInstructions, accessedInstructions],
                ([makeIndex, makeAccess]) => [
                    ...makeIndex,
                    ...makeAccess,
                    { kind: 'loadMemory', from: accessed, to: length, offset: 0, why: 'get the length of the list' },
                    { kind: 'gotoIfGreater', label: outOfRange, lhs: index, rhs: length, why: 'check OOB' },
                    { kind: 'add', destination: itemAddress, lhs: index, rhs: accessed, why: 'get address of item' },
                    {
                        kind: 'loadMemory',
                        from: itemAddress,
                        to: destination,
                        offset: 1,
                        why: 'add one to adjust for length',
                    },
                    { kind: 'label', name: outOfRange, why: 'lol' },
                    // TODO: exit on out of range
                ]
            );
        }
        case 'typeDeclaration':
            return compileExpression([], ([]) => []);
        default:
            throw debug(`${(ast as any).kind} unhandled in astToThreeAddressCode`);
    }
};

export const constructFunction = (
    f: Function,
    globalNameMap,
    stringLiterals,
    makeLabel,
    makeTemporary,
    types: TypeDeclaration[],
    targetInfo: TargetInfo
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
                destination: 'functionResult', // TOOD: wtf is functionResult doing here?
                globalNameMap,
                stringLiterals,
                makeTemporary,
                makeLabel,
                types,
                targetInfo,
            });
            const freeLocals = f.variables
                // TODO: Make a better memory model for frees.
                .filter(s => s.type.kind == 'String')
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
    return { name: f.name, instructions: functionCode, spills: 0 };
};

export const threeAddressCodeToTarget = <TargetRegister>(
    tas: Statement,
    stackOffset: number,
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
            const syscallNumber = syscallNumbers[tas.name];
            if (syscallNumber === undefined) debug(`missing syscall number for (${tas.name})`);
            const result: TargetThreeAddressStatement<TargetRegister>[] = [
                ...registersToSave.map(r => ({
                    kind: 'push' as 'push',
                    register: r,
                    why: 'save registers',
                })),
                ...tas.arguments.map((arg, index) =>
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
                    value: syscallNumber,
                    destination: registerTypes.syscallSelectAndResult,
                    why: `syscall select (${tas.name})`,
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
        case 'gotoIfNotEqual':
            if (typeof tas.rhs == 'number') {
                return [{ ...tas, lhs: getRegister(tas.lhs), rhs: tas.rhs }];
            }
            return [{ ...tas, lhs: getRegister(tas.lhs), rhs: getRegister(tas.rhs) }];
        case 'gotoIfEqual':
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
        case 'stackAllocateAndStorePointer':
            return [
                {
                    kind: 'loadStackOffset',
                    register: getRegister(tas.register),
                    offset: stackOffset + tas.bytes,
                    why: tas.why,
                },
            ];
        case 'spill': {
            return [
                {
                    kind: 'stackStore',
                    register: getRegister(tas.register),
                    offset: stackOffset + tas.offset,
                    why: tas.why,
                },
            ];
        }
        case 'unspill': {
            if (Number.isNaN(stackOffset + tas.offset)) debug('nan!');
            return [
                {
                    kind: 'stackLoad',
                    register: getRegister(tas.register),
                    offset: stackOffset + tas.offset,
                    why: tas.why,
                },
            ];
        }
        default:
            throw debug(`${(tas as any).kind} unhandled in threeAddressCodeToTarget`);
    }
};

export type ThreeAddressProgram = {
    globals: { [key: string]: { mangledName: string; bytes: number } };
    functions: ThreeAddressFunction[];
    main: Statement[] | undefined;
    stringLiterals: StringLiteralData[];
};

export type MakeAllFunctionsInput = {
    backendInputs;
    targetInfo: TargetInfo;
};

export const makeTargetProgram = ({ backendInputs, targetInfo }: MakeAllFunctionsInput): ThreeAddressProgram => {
    const { types, functions, program, globalDeclarations, stringLiterals } = backendInputs;
    const temporaryNameMaker = idAppender();
    const makeTemporary = name => ({ name: temporaryNameMaker(name) });
    const labelMaker = idAppender();
    const globalNameMaker = idAppender();

    const globalNameMap: { [key: string]: GlobalInfo } = {};
    const globals = {};
    globalDeclarations.forEach(declaration => {
        const mangledName = globalNameMaker(declaration.name);
        globalNameMap[declaration.name] = {
            newName: mangledName,
            originalDeclaration: declaration,
        };
        globals[declaration.name] = { mangledName, bytes: typeSize(targetInfo, declaration.type, types) };
    });

    const userFunctions: ThreeAddressFunction[] = functions.map(f =>
        constructFunction(f, globalNameMap, stringLiterals, labelMaker, makeTemporary, types, targetInfo)
    );

    const mainProgramInstructions: Statement[] = flatten(
        program.statements.map(statement => {
            const compiledProgram = astToThreeAddressCode({
                ast: statement,
                destination: 'functionResult',
                globalNameMap,
                stringLiterals,
                variablesInScope: {},
                makeLabel: labelMaker,
                makeTemporary,
                types,
                targetInfo,
            });

            return [...compiledProgram.prepare, ...compiledProgram.execute, ...compiledProgram.cleanup];
        })
    );

    const freeGlobalsInstructions: Statement[] = flatten(
        globalDeclarations
            .filter(declaration => declaration.type.kind === 'String')
            .map(declaration => [
                {
                    kind: 'loadGlobal',
                    from: globalNameMap[declaration.name].newName,
                    to: 'functionArgument1',
                    why: 'Load global string so we can free it',
                } as Statement,
                {
                    kind: 'callByName',
                    function: 'my_free',
                    why: 'Free global string at end of program',
                } as Statement,
            ])
    );

    const mainProgram: Statement[] = [
        ...mainProgramInstructions,
        ...freeGlobalsInstructions,
        { kind: 'callByName', function: 'verify_no_leaks', why: 'Check for leaks' },
        ...targetInfo.cleanupCode,
    ];

    const runtimeFunctions = [
        length,
        stringEqualityRuntimeFunction,
        stringConcatenateRuntimeFunction,
        stringCopy,
        myFreeRuntimeFunction,
        verifyNoLeaks,
        intFromString,
    ].map(f => f(targetInfo.bytesInWord));

    const nonMainFunctions = [
        ...runtimeFunctions,
        targetInfo.mallocImpl,
        targetInfo.printImpl,
        targetInfo.readIntImpl,
        ...userFunctions,
    ];

    // Omit unused functions
    const closedSet: ThreeAddressFunction[] = [];
    // Seed open set with dummy function consisting of the one function we are guaranteed to use (main)
    const openSet = [{ name: 'main', instructions: mainProgram }];
    while (openSet.length > 0) {
        const f = openSet.shift() as ThreeAddressFunction;
        closedSet.push(f);
        f.instructions.forEach(statement => {
            if (statement.kind == 'callByName') {
                const usedFunction = nonMainFunctions.find(f2 => f2.name == statement.function);
                if (usedFunction) {
                    if (
                        closedSet.find(f2 => f2.name == usedFunction.name) ||
                        openSet.find(f2 => f2.name == usedFunction.name)
                    ) {
                        // We already know about this function
                    } else {
                        openSet.push(usedFunction);
                    }
                }
            } else if (statement.kind == 'loadSymbolAddress') {
                const usedFunction = nonMainFunctions.find(f2 => f2.name == statement.symbolName);
                if (usedFunction) {
                    if (
                        closedSet.find(f2 => f2.name == usedFunction.name) ||
                        openSet.find(f2 => f2.name == usedFunction.name)
                    ) {
                        // We already know about this function
                    } else {
                        openSet.push(usedFunction);
                    }
                }
            }
        });
    }

    // Remove dummy main function we added at start
    closedSet.shift();
    return { globals, functions: closedSet, main: mainProgram, stringLiterals: backendInputs.stringLiterals };
};
