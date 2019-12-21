import { RegisterAgnosticTargetInfo } from '../TargetInfo.js';
import { Function } from './Function.js';
import { Program } from './Program.js';
import {
    length,
    intFromString,
    stringCopy,
    verifyNoLeaks,
    stringConcatenateRuntimeFunction,
    stringEqualityRuntimeFunction,
    myFreeRuntimeFunction,
} from './runtime.js';
import idAppender from '../util/idAppender.js';
import * as Ast from '../ast.js';
import flatten from '../util/list/flatten.js';
import drain from '../util/list/drain.js';
import { builtinFunctions, Type, TypeDeclaration, resolve, typeSize } from '../types.js';
import debug from '../util/debug.js';
import {
    CompiledExpression,
    compileExpression,
    stringLiteralName,
    freeGlobalsInstructions,
} from '../backend-utils.js';
import { Register, toString as s } from '../register.js';
import {
    FrontendOutput,
    Function as ApiFunction,
    VariableDeclaration,
    StringLiteralData,
} from '../api.js';
import { Statement } from './statement.js';
import { parseInstructionsOrDie as ins } from './parser.js';

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
    targetInfo: RegisterAgnosticTargetInfo;
};

const memberOffset = (
    type: Type,
    memberName: string,
    { bytesInWord }: RegisterAgnosticTargetInfo
): number => {
    if (type.kind != 'Product') throw debug('need a product here');
    const result = type.members.findIndex(m => m.name == memberName);
    if (result < 0) throw debug('coudnt find member');
    return result * bytesInWord;
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
            console.log(destination);
            console.log(`${s(destination)} = ${ast.value}; Load number literal`);

            return compileExpression<Statement>([], ([]) =>
                ins(`${s(destination)} = ${ast.value}; Load number literal`)
            );
        case 'booleanLiteral':
            return compileExpression<Statement>([], ([]) =>
                ins(`${s(destination)} = ${ast.value ? 1 : 0}; Load boolean literal`)
            );
        case 'stringLiteral': {
            const stringLiteralData = stringLiterals.find(({ value }) => value == ast.value);
            if (!stringLiteralData) throw debug('todo');
            return compileExpression<Statement>([], ([]) =>
                ins(
                    `${s(destination)} = &${stringLiteralName(
                        stringLiteralData
                    )}; Load string literal address`
                )
            );
        }
        case 'functionLiteral':
            return compileExpression<Statement>([], ([]) =>
                ins(`${s(destination)} = &${ast.deanonymizedName}; Load function into register`)
            );
        case 'returnStatement':
            const result = makeTemporary('result');
            const subExpression = recurse({ ast: ast.expression, destination: result });
            const cleanupAndReturn = {
                prepare: [],
                execute: [],
                cleanup: ins(`return ${s(result)}; Return previous expression`),
            };
            return compileExpression<Statement>(
                [cleanupAndReturn, subExpression],
                ([_, e1]) => e1
            );
        case 'subtraction': {
            const lhs = makeTemporary('addition_lhs');
            const rhs = makeTemporary('addition_rhs');
            const computeLhs = recurse({ ast: ast.lhs, destination: lhs });
            const computeRhs = recurse({ ast: ast.rhs, destination: rhs });
            return compileExpression<Statement>(
                [computeLhs, computeRhs],
                ([storeLeft, storeRight]) => [
                    ...storeLeft,
                    ...storeRight,
                    ...ins(`${s(destination)} = ${s(lhs)} - ${s(rhs)}; Evaluate subtraction`),
                ]
            );
        }
        case 'addition': {
            const lhs = makeTemporary('addition_lhs');
            const rhs = makeTemporary('addition_rhs');
            const computeLhs = recurse({ ast: ast.lhs, destination: lhs });
            const computeRhs = recurse({ ast: ast.rhs, destination: rhs });
            return compileExpression<Statement>(
                [computeLhs, computeRhs],
                ([storeLeft, storeRight]) => [
                    ...storeLeft,
                    ...storeRight,
                    ...ins(`${s(destination)} = ${s(lhs)} + ${s(rhs)}; Evaluate addition`),
                ]
            );
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
                    ...ins(`
                        goto ${endOfTernaryLabel}; Jump to end of ternary
                    ${falseBranchLabel}:; False branch begin
                    `),
                    ...e3,
                    { kind: 'label', name: endOfTernaryLabel, why: 'End of ternary label' },
                ]
            );
        }
        case 'callExpression': {
            const argumentRegisters: Register[] = [];
            const argumentComputers: CompiledExpression<Statement>[] = [];
            ast.arguments.map((argument, index) => {
                const argumentRegister = makeTemporary(`argument${index}`);
                const argumentComputer = recurse({
                    ast: argument,
                    destination: argumentRegister,
                });
                argumentRegisters.push(argumentRegister);
                argumentComputers.push(argumentComputer);
            });

            const functionName = ast.name;
            let callInstructions: Statement[] = [];
            if (builtinFunctions.map(b => b.name).includes(functionName)) {
                const functionPointer = makeTemporary('function_pointer');
                callInstructions = [
                    {
                        kind: 'loadSymbolAddress',
                        symbolName: functionName,
                        to: functionPointer,
                        why: 'Load runtime function',
                    },
                    {
                        kind: 'callByRegister',
                        function: functionPointer,
                        arguments: argumentRegisters,
                        destination,
                        why: `Call runtime ${functionName}`,
                    },
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
                    {
                        kind: 'callByRegister',
                        function: functionPointer,
                        arguments: argumentRegisters,
                        destination,
                        why: `Call global ${functionName}`,
                    },
                ];
            } else if (functionName in variablesInScope) {
                callInstructions = [
                    {
                        kind: 'callByRegister',
                        function: variablesInScope[functionName],
                        arguments: argumentRegisters,
                        destination,
                        why: `Call by register ${functionName}`,
                    },
                ];
            } else {
                debug('todo');
            }

            return compileExpression<Statement>(argumentComputers, argComputers => [
                ...flatten(argComputers),
                { kind: 'empty', why: `call ${functionName}` },
                ...callInstructions,
            ]);
        }
        case 'equality': {
            if (ast.type.kind == 'String') {
                // Put left in s0 and right in s1 for passing to string equality function
                const lhsArg = makeTemporary('lhs');
                const storeLeftInstructions = recurse({ ast: ast.lhs, destination: lhsArg });
                const rhsArg = makeTemporary('rhs');
                const storeRightInstructions = recurse({ ast: ast.rhs, destination: rhsArg });
                return compileExpression<Statement>(
                    [storeLeftInstructions, storeRightInstructions],
                    ([e1, e2]) => [
                        ...e1,
                        ...e2,
                        {
                            kind: 'callByName',
                            function: 'stringEquality',
                            arguments: [lhsArg, rhsArg],
                            destination,
                            why: 'Call stringEquality',
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

                return compileExpression<Statement>(
                    [storeLeftInstructions, storeRightInstructions],
                    ([storeLeft, storeRight]) => [
                        ...storeLeft,
                        ...storeRight,
                        {
                            kind: 'gotoIfEqual',
                            lhs,
                            rhs,
                            label: equalLabel,
                            why: 'Goto set 1 if equal',
                        },
                        {
                            kind: 'loadImmediate',
                            value: 0,
                            destination,
                            why: 'Not equal, set 0',
                        },
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
                const computeRhs = recurse({ ast: ast.expression, destination: rhs });
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
                            ...ins(`
                                r:len = length(${s(rhs)}); Get string length
                                r:len++; Add one for null terminator
                                r:space = my_malloc(r:len); Allocate that much space
                                string_copy(${s(rhs)}, r:space); Copy string into allocated space
                                *${lhsInfo.newName} = r:space; Store into global
                            `),
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
                                    const offset = i * targetInfo.bytesInWord; // TODO: Should add up sizes of preceeding members
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
                                kind: 'alloca',
                                bytes: typeSize(targetInfo, ast.type, types),
                                register: destination,
                                why: 'make stack space for lhs',
                            },
                            ...copyStructInstructions,
                        ]);
                    case 'List':
                        const remainingCount = makeTemporary('remainingCount');
                        const copyLoop = makeLabel('copyLoop');
                        const targetAddress = makeTemporary('targetAddress');
                        const itemSize = makeTemporary('itemSize');
                        const sourceAddress = makeTemporary('sourceAddress');
                        const temp = makeTemporary('temp');
                        return compileExpression<Statement>([computeRhs], ([e1]) => [
                            ...e1,
                            ...ins(`
                                ${s(remainingCount)} = *(${s(rhs)} + 0); Get length of list
                                ${s(sourceAddress)} = ${s(
                                rhs
                            )}; Local copy of source data pointer
                                ${s(itemSize)} = ${targetInfo.bytesInWord}; For multiplying
                                ${s(remainingCount)} = ${s(remainingCount)} * ${s(
                                itemSize
                            )}; Count = count * size
                                ${s(remainingCount)} += ${
                                targetInfo.bytesInWord
                            }; Add place to store length of list
                                ${s(destination)} = my_malloc(${s(remainingCount)}); Malloc
                                ${s(targetAddress)} = ${s(
                                destination
                            )}; Local copy of dest data pointer
                            ${copyLoop}:; Copy loop
                                ${s(temp)} = *(${s(sourceAddress)} + 0); Copy a byte
                                *(${s(targetAddress)} + 0) = ${s(temp)}; Finish copy
                                ${s(remainingCount)} += ${-targetInfo.bytesInWord}; Bump pointers
                                ${s(sourceAddress)} += ${targetInfo.bytesInWord}; Bump pointers
                                ${s(targetAddress)} += ${targetInfo.bytesInWord}; Bump pointers
                                goto ${copyLoop} if ${s(remainingCount)} != 0; Not done
                                *${lhsInfo.newName} = ${s(
                                destination
                            )}; Store global. TODO: really????
                            `),
                        ]);
                    default:
                        const unhandled = lhsInfo.originalDeclaration.type.kind;
                        throw debug(`${unhandled} unhandled in typedDeclarationAssignment`);
                }
            } else if (lhs in variablesInScope) {
                return recurse({ ast: ast.expression, destination: variablesInScope[lhs] });
            } else {
                throw debug('Declared variable was neither global nor local');
            }
        }
        case 'reassignment': {
            const lhs: string = ast.destination;
            if (lhs in globalNameMap) {
                const reassignmentRhs = makeTemporary('reassignment_rhs');
                const rhs = recurse({ ast: ast.expression, destination: reassignmentRhs });
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
                        const lengthTemp = makeTemporary('lenght');
                        const space = makeTemporary('space');
                        const prepAndCleanup = {
                            prepare: [
                                {
                                    kind: 'loadGlobal' as 'loadGlobal',
                                    to: oldData,
                                    from: declaration.newName,
                                    why: 'Save global for freeing after assignment',
                                },
                            ],
                            execute: [],
                            cleanup: [
                                {
                                    kind: 'callByName' as 'callByName',
                                    function: 'my_free',
                                    arguments: [oldData],
                                    destination: null,
                                    why: 'Free string that is no longer accessible',
                                },
                            ],
                        };
                        return compileExpression<Statement>([rhs, prepAndCleanup], ([e1, _]) => [
                            ...e1,
                            {
                                kind: 'callByName',
                                function: 'length',
                                arguments: [reassignmentRhs],
                                destination: lengthTemp,
                                why: 'Get length of new string',
                            },
                            {
                                kind: 'callByName',
                                function: 'my_malloc',
                                arguments: [lengthTemp],
                                destination: space,
                                why: 'Allocate space for new string',
                            },
                            {
                                kind: 'storeGlobal',
                                from: space,
                                to: declaration.newName,
                                why: 'Store location of allocated memory to global',
                            },
                            {
                                kind: 'callByName',
                                function: 'string_copy',
                                arguments: [reassignmentRhs, space],
                                destination: null,
                                why: 'Copy new string to destination',
                            },
                        ]);
                    default:
                        throw debug('todo');
                }
            } else if (lhs in variablesInScope) {
                return recurse({ ast: ast.expression, destination: variablesInScope[lhs] });
            } else {
                throw debug('Reassigned variable was neither global nor local');
            }
        }
        case 'concatenation': {
            const lhs = makeTemporary('concat_lhs');
            const rhs = makeTemporary('concat_rhs');
            const combinedLength = makeTemporary('concat_result_length');
            const doneFree = makeLabel('doneFree');
            const allocated = makeTemporary('allocated');

            const makeLhs = recurse({ ast: ast.lhs, destination: lhs });
            const makeRhs = recurse({ ast: ast.rhs, destination: rhs });
            const reqs: CompiledExpression<Statement> = {
                prepare: ins(`${s(allocated)} = 0; Will set to true if we need to clean up`),
                execute: [],
                cleanup: ins(`
                    goto ${doneFree} if ${s(
                    allocated
                )} == 0; If we never allocated, we should never free
                    my_free(${s(
                        destination
                    )}); Free destination of concat (TODO: are we sure we aren't using it?)
                ${doneFree}:; Done free
                `),
            };
            return compileExpression<Statement>([makeLhs, makeRhs, reqs], ([e1, e2, _]) => [
                ...ins(
                    `${s(
                        combinedLength
                    )} = 1; Combined length. Start with 1 for null terminator.`
                ),
                ...e1,
                ...e2,
                ...ins(`
                        r:lhsLength = length(${s(lhs)}); Compute lhs length
                        ${s(combinedLength)} = ${s(combinedLength)} + r:lhsLength; Accumulate it
                        r:rhsLength = length(${s(rhs)}); Compute rhs length
                        ${s(combinedLength)} = ${s(combinedLength)} + r:rhsLength; Accumulate it
                        ${s(destination)} = my_malloc(${s(
                    combinedLength
                )}); Allocate space for new string
                        ${s(allocated)} = 1; Remind ourselves to decallocate
                        string_concatenate(${s(lhs)}, ${s(rhs)}, ${s(
                    destination
                )}); Concatenate and put in new space
                    `),
            ]);
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
            const createObjectMembers: CompiledExpression<Statement>[] = ast.members.map(
                (m, index) => {
                    const memberTemporary = makeTemporary(`member_${m.name}`);
                    return compileExpression(
                        [recurse({ ast: m.expression, destination: memberTemporary })],
                        ([storeMemberInstructions]) => [
                            ...storeMemberInstructions,
                            {
                                kind: 'storeMemory' as 'storeMemory',
                                from: memberTemporary,
                                address: destination,
                                offset: index * targetInfo.bytesInWord, // TODO: proper alignment and offsets
                                why: `object literal member ${m.name}`,
                            },
                        ]
                    );
                }
            );
            return compileExpression<Statement>(createObjectMembers, members => [
                {
                    kind: 'alloca',
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
            const listLength = makeTemporary('listLength');
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
                            //  Plus 1 because we leave one word for list length. TODO: proper alignment for lists of larger-than-word types.
                            offset: (index + 1) * targetInfo.bytesInWord,
                            why: 'Store this item in the list',
                        },
                    ]
                );
            });
            const prepAndCleanup: CompiledExpression<Statement> = {
                prepare: [
                    {
                        kind: 'loadImmediate' as 'loadImmediate',
                        value: ast.items.length * typeSize(targetInfo, ast.type, types),
                        destination: bytesToAllocate,
                        why: 'num bytes for list',
                    },
                    {
                        kind: 'addImmediate',
                        register: bytesToAllocate,
                        amount: targetInfo.bytesInWord,
                        why: 'add room for length',
                    },
                    {
                        kind: 'callByName',
                        function: 'my_malloc',
                        arguments: [bytesToAllocate],
                        destination: dataPointer,
                        why: 'Allocate that much space',
                    },
                    {
                        kind: 'loadImmediate',
                        value: ast.items.length,
                        destination: listLength,
                        why: 'store size',
                    },
                    {
                        kind: 'storeMemory',
                        from: listLength,
                        address: dataPointer,
                        offset: 0,
                        why: 'save list length',
                    },
                    {
                        kind: 'move',
                        from: dataPointer,
                        to: destination,
                        why: 'save memory for pointer',
                    },
                ],
                execute: [],
                cleanup: [
                    {
                        kind: 'callByName',
                        function: 'my_free',
                        arguments: [dataPointer],
                        destination: null,
                        why: 'free temporary list',
                    },
                ],
            };
            return compileExpression<Statement>(
                [prepAndCleanup, ...createItems],
                ([allocate, create]) => [...allocate, ...create]
            );
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
            const listLength = makeTemporary('length');
            const outOfRange = makeLabel('outOfRange');
            const itemAddress = makeTemporary('itemAddress');
            return compileExpression<Statement>(
                [indexInstructions, accessedInstructions],
                ([makeIndex, makeAccess]) => [
                    ...makeIndex,
                    ...makeAccess,
                    {
                        kind: 'loadMemory',
                        from: accessed,
                        to: listLength,
                        offset: 0,
                        why: 'get the length of the list',
                    },
                    {
                        kind: 'gotoIfGreater',
                        label: outOfRange,
                        lhs: index,
                        rhs: listLength,
                        why: 'check OOB',
                    },
                    {
                        kind: 'add',
                        destination: itemAddress,
                        lhs: index,
                        rhs: accessed,
                        why: 'get address of item',
                    },
                    {
                        kind: 'loadMemory',
                        from: itemAddress,
                        to: destination,
                        offset: targetInfo.bytesInWord,
                        why: 'add one word to adjust for length',
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
    f: ApiFunction,
    globalNameMap,
    stringLiterals,
    makeLabel,
    makeTemporary,
    types: TypeDeclaration[],
    targetInfo: RegisterAgnosticTargetInfo,
    liveAtExit: Register[]
): Function => {
    const variablesInScope: { [key: string]: Register } = {};
    const args: Register[] = [];
    f.parameters.forEach((parameter, index) => {
        const param = makeTemporary(parameter.name);
        args.push(param);
        variablesInScope[parameter.name] = param;
    });

    f.statements.forEach(statement => {
        if (statement.kind === 'typedDeclarationAssignment') {
            variablesInScope[statement.destination] = makeTemporary(
                `local_${statement.destination}`
            );
        }
    });

    const functionCode = flatten(
        f.statements.map(statement => {
            const compiledProgram = astToThreeAddressCode({
                ast: statement,
                variablesInScope,
                destination: makeTemporary('unused'), // TOOD: get rid of this unused variable
                globalNameMap,
                stringLiterals,
                makeTemporary,
                makeLabel,
                types,
                targetInfo,
            });

            return [
                ...compiledProgram.prepare,
                ...compiledProgram.execute,
                ...compiledProgram.cleanup,
            ];
        })
    );
    return { name: f.name, instructions: functionCode, liveAtExit, spills: 0, arguments: args };
};

export type MakeAllFunctionsInput = {
    backendInputs: FrontendOutput;
    targetInfo: RegisterAgnosticTargetInfo;
};

export const makeTargetProgram = ({
    backendInputs,
    targetInfo,
}: MakeAllFunctionsInput): Program => {
    const { types, functions, program, globalDeclarations, stringLiterals } = backendInputs;
    const temporaryNameMaker = idAppender();
    const makeTemporary = name => ({ name: temporaryNameMaker(name) });
    const labelMaker = idAppender();
    const globalNameMaker = idAppender();
    const exitCodeRegister = makeTemporary('exitCodeRegister');

    const globalNameMap: { [key: string]: GlobalInfo } = {};
    const globals = {};
    globalDeclarations.forEach(declaration => {
        const mangledName = globalNameMaker(declaration.name);
        globalNameMap[declaration.name] = {
            newName: mangledName,
            originalDeclaration: declaration,
        };
        globals[declaration.name] = {
            mangledName,
            bytes: typeSize(targetInfo, declaration.type, types),
        };
    });

    const userFunctions: Function[] = functions.map(f =>
        constructFunction(
            f,
            globalNameMap,
            stringLiterals,
            labelMaker,
            makeTemporary,
            types,
            targetInfo,
            [exitCodeRegister]
        )
    );

    const mainProgramInstructions: Statement[] = flatten(
        program.statements.map(statement => {
            const compiledProgram = astToThreeAddressCode({
                ast: statement,
                destination: exitCodeRegister,
                globalNameMap,
                stringLiterals,
                variablesInScope: {},
                makeLabel: labelMaker,
                makeTemporary,
                types,
                targetInfo,
            });

            return [
                ...compiledProgram.prepare,
                ...compiledProgram.execute,
                ...compiledProgram.cleanup,
            ];
        })
    );

    const mainFunction: Function = {
        name: 'main',
        instructions: mainProgramInstructions,
        liveAtExit: [exitCodeRegister],
        arguments: [],
        spills: 0,
    };
    const freeGlobals = {
        name: 'free_globals',
        instructions: freeGlobalsInstructions(globalDeclarations, makeTemporary, globalNameMap),
        liveAtExit: [],
        arguments: [],
        spills: 0,
    };
    const runtimeFunctions = [
        length,
        stringEqualityRuntimeFunction,
        stringConcatenateRuntimeFunction,
        stringCopy,
        myFreeRuntimeFunction,
        intFromString,
    ].map(f => f(targetInfo.bytesInWord));
    const nonMainFunctions = [
        ...runtimeFunctions,
        targetInfo.functionImpls.mallocImpl,
        targetInfo.functionImpls.printImpl,
        targetInfo.functionImpls.readIntImpl,
        ...userFunctions,
    ];

    // Omit unused functions
    const closedSet: Function[] = [];
    // Seed open set with the functions we are guaranteed to use:
    //  - main: entry point
    //  - verify_no_leaks: currently always called as a sanity check
    //  - free_globals: freeing globals is done externally to main
    // Always include verify_no_leaks and free_globals because we always call them, from the external cleanup
    const openSet: Function[] = [
        mainFunction,
        verifyNoLeaks(targetInfo.bytesInWord),
        freeGlobals,
    ];
    drain(openSet, currentFunction => {
        closedSet.push(currentFunction);
        currentFunction.instructions.forEach(statement => {
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
                const usedFunction = nonMainFunctions.find(
                    f2 => f2.name == statement.symbolName
                );
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
    });

    // Main is reported sepeartely, so we remove it (it's guaranteed to be at the front becuase we put it in openSet at the front)
    const main = closedSet.shift();
    if (!main) throw debug('no main');
    return { globals, functions: closedSet, main, stringLiterals: backendInputs.stringLiterals };
};
