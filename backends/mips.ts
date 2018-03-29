import { exec } from 'child-process-promise';
import { isEqual } from 'lodash';
import flatten from '../util/list/flatten.js';
import { VariableDeclaration, BackendInputs, ExecutionResult, Function, StringLiteralData } from '../api.js';
import * as Ast from '../ast.js';
import debug from '../util/debug.js';
import {
    CompiledProgram,
    BackendOptions,
    compileExpression,
    StorageSpec,
    RegisterAssignment,
    storageSpecToString,
    stringLiteralName,
} from '../backend-utils.js';
import {
    astToRegisterTransferLanguage,
    constructFunction,
    PureRegisterTransferLanguageExpression,
    RegisterTransferLanguageExpression,
} from './registerTransferLanguage.js';
import { malloc } from './registerTransferLanguageRuntime.js';
import { errors } from '../runtime-strings.js';
import { builtinFunctions } from '../frontend.js';
import join from '../util/join.js';

// 's' registers are used for the args, starting as 0. Spill recovery shall start at the last (7)
const argument1 = '$s0';
const argument2 = '$s1';
const argument3 = '$s2';
const syscallArg1 = '$a0';
const syscallArg2 = '$a1';
const syscallResult = '$v0';
const syscallSelect = '$v0';
const functionResult = '$a0';

const knownRegisters = {
    argument1,
    argument2,
    argument3,
    functionResult,
    syscallArg1,
    syscallSelect,
    syscallResult,
};

const add = ({ l, r, to }: { l: string; r: string; to: string }) => `add ${to}, ${l}, ${r}`;

const multiplyMips = (destination, left, right) => {
    let leftRegister = left.destination;
    let loadSpilled: any = [];
    let restoreSpilled: any = [];
    if (left.type == 'memory') {
        leftRegister = '$s1';
        loadSpilled.push(`lw $s1, -${left.spOffset}($sp)`);
    }

    let rightRegister = right.destination;
    if (right.type == 'memory') {
        rightRegister = '$s2';
        loadSpilled.push(`lw $s2, -${right.spOffset}($sp)`);
    }

    let destinationRegister = destination.destination;
    if (destination.type == 'memory') {
        destinationRegister = '$s3';
        restoreSpilled.push(`sw $s3, -${destination.spOffset}($sp)`);
    }
    if (leftRegister == '$tNaN') debug('todo');

    return [
        ...loadSpilled,
        `mult ${leftRegister}, ${rightRegister}`,
        `# Move result to final destination (assume no overflow)`,
        `mflo ${destinationRegister}`,
        ...restoreSpilled,
    ].join('\n');
};

const firstRegister: StorageSpec = { type: 'register', destination: '$t1' };
const nextTemporary = (storage: StorageSpec): StorageSpec => {
    if (storage.type == 'register') {
        if (storage.destination == '$t9') {
            // Now need to spill
            return {
                type: 'memory',
                spOffset: 0,
            };
        } else {
            return {
                type: 'register',
                destination: `$t${parseInt(storage.destination[storage.destination.length - 1]) + 1}`,
            };
        }
    } else if (storage.type == 'memory') {
        return {
            type: 'memory',
            spOffset: storage.spOffset + 4,
        };
    } else {
        return debug('todo');
    }
};

let labelId = 0;

const astToMips = (input: BackendOptions): CompiledProgram => {
    const { ast, registerAssignment, destination, currentTemporary, globalDeclarations, stringLiterals } = input;
    if (isEqual(currentTemporary, destination)) throw debug('todo'); // Sanity check to make sure caller remembered to provide a new temporary
    const recurse = newInput => astToMips({ ...input, ...newInput });
    const makeLabel = (name: string) => {
        const result = `${name}${labelId}`;
        labelId++;
        return result;
    };
    if (!ast) debug('todo');
    switch (ast.kind) {
        case 'number':
        case 'returnStatement':
        case 'subtraction':
        case 'ternary':
        case 'booleanLiteral':
        case 'functionLiteral':
        case 'callExpression':
        case 'equality':
        case 'stringLiteral':
        case 'typedDeclarationAssignment':
            return astToRegisterTransferLanguage(input, knownRegisters, nextTemporary, makeLabel, recurse);
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
            return compileExpression([storeLeftInstructions, storeRightInstructions], ([storeLeft, storeRight]) => [
                `# Store left side of product in temporary (${storageSpecToString(leftSideDestination)})`,
                ...storeLeft,
                `# Store right side of product in destination (${storageSpecToString(rightSideDestination)})`,
                ...storeRight,
                `# Evaluate product`,
                multiplyMips(destination, leftSideDestination, rightSideDestination),
            ]);
        }
        case 'addition': {
            if (destination.type !== 'register') throw debug('todo');
            const leftSideDestination = currentTemporary;
            if (leftSideDestination.type !== 'register') throw debug('todo');
            const rightSideDestination = destination;
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
                `# Evaluate addition`,
                add({
                    l: leftSideDestination.destination,
                    r: rightSideDestination.destination,
                    to: destination.destination,
                }),
            ]);
        }
        case 'reassignment': {
            const lhs = ast.destination;
            if (globalDeclarations.some(declaration => declaration.name === lhs)) {
                const subExpressionTemporary = nextTemporary(currentTemporary);
                const savedPointerForFreeing = subExpressionTemporary;
                const rhs: CompiledProgram = recurse({
                    ast: ast.expression,
                    destination: currentTemporary,
                    currentTemporary: nextTemporary(subExpressionTemporary),
                });
                const declaration = globalDeclarations.find(declaration => declaration.name === lhs);
                if (!declaration) throw debug('todo');
                if (currentTemporary.type !== 'register') throw debug('todo');
                switch (declaration.type.name) {
                    case 'Function':
                    case 'Integer':
                        return compileExpression([rhs], ([e1]) => [
                            `# Put ${declaration.type.name} into temporary`,
                            ...e1,
                            {
                                kind: 'storeGlobal',
                                from: currentTemporary.destination,
                                to: lhs,
                                why: 'Store into global',
                            },
                        ]);
                    case 'String':
                        if (!('destination' in savedPointerForFreeing)) throw debug('todo');
                        const prepAndCleanup = {
                            prepare: [
                                `lw ${
                                    savedPointerForFreeing.destination
                                }, ${lhs} # Save global for freeing after assignment`,
                            ],
                            execute: [],
                            cleanup: [
                                {
                                    kind: 'move',
                                    from: savedPointerForFreeing.destination,
                                    to: argument1,
                                    why: 'Move global to argument 1 of free',
                                },
                                { kind: 'call', function: 'my_free', why: 'Free string that is no longer accessible' },
                            ] as RegisterTransferLanguageExpression[],
                        };
                        return compileExpression([rhs, prepAndCleanup], ([e1, _]) => [
                            ...e1,
                            {
                                kind: 'move',
                                from: currentTemporary.destination,
                                to: argument1,
                                why: 'Move from temporary to argument 1',
                            },
                            { kind: 'call', function: 'length', why: 'Get length of new string' },
                            {
                                kind: 'move',
                                from: functionResult,
                                to: argument1,
                                why: 'Move length of new string to argument of malloc',
                            },
                            { kind: 'call', function: 'my_malloc', why: 'Allocate space for new string' },
                            {
                                kind: 'storeGlobal',
                                from: functionResult,
                                to: lhs,
                                why: 'Store location of allocated memory to global',
                            },
                            {
                                kind: 'move',
                                from: functionResult,
                                to: argument2,
                                why: 'Move output pointer to argument 2 of string_copy',
                            },
                            {
                                kind: 'move',
                                from: currentTemporary.destination,
                                to: argument1,
                                why: 'move destination to argument 1 of string_copy',
                            },
                            { kind: 'call', function: 'string_copy', why: 'Copy new string to destination' },
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
                        destination: `${(registerAssignment[lhs] as any).destination}`,
                    },
                });
            } else {
                throw debug('todo');
            }
        }
        case 'identifier': {
            // TODO: Better handle identifiers here. Also just better storage/scope chains?
            const identifierName = ast.value;
            if (globalDeclarations.some(declaration => declaration.name === identifierName)) {
                const declaration = globalDeclarations.find(declaration => declaration.name === identifierName);
                if (!declaration) throw debug('todo');
                return compileExpression([], ([]) => [
                    {
                        kind: 'loadGlobal',
                        to: destination,
                        from: identifierName,
                        why: `Load ${identifierName} from global into register`,
                    },
                ]);
            }
            const identifierRegister = (registerAssignment[identifierName] as any).destination;
            return compileExpression([], ([]) => [
                {
                    kind: 'move',
                    from: identifierRegister,
                    to: (destination as any).destination,
                    why: `Move from ${identifierName} (${identifierRegister}) into destination (${
                        (destination as any).destination
                    }`,
                },
            ]);
        }
        case 'concatenation': {
            if (destination.type !== 'register') throw debug('todo');
            const leftSideDestination = currentTemporary;
            if (leftSideDestination.type !== 'register') throw debug('todo');
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
            const cleanup: CompiledProgram = {
                prepare: [],
                execute: [],
                cleanup: [
                    {
                        kind: 'move',
                        from: mallocResultTemporary.destination,
                        to: argument1,
                        why: 'Move pointer to new string to argument1',
                    },
                    // TODO: maybe not valid? This destination may have been reused for something else by the time we get to cleanup
                    { kind: 'call', function: 'my_free', why: 'Freeing temporary from concat' },
                ],
            };
            return compileExpression([storeLeftInstructions, storeRightInstructions, cleanup], ([e1, e2, _]) => [
                `# Create a temporary to store new string length. Start with 1 for null terminator.`,
                `li ${newStringLengthTemporary.destination}, 1`,
                `# Compute lhs`,
                ...e1,
                `# Compute rhs`,
                ...e2,
                { kind: 'move', from: leftSideDestination.destination, to: argument1, why: 'Move lhs to argument1' },
                { kind: 'call', function: 'length', why: 'Compute the length of lhs and add it to length temporary' },
                add({
                    l: functionResult,
                    r: newStringLengthTemporary.destination,
                    to: newStringLengthTemporary.destination,
                }),
                { kind: 'move', from: rightSideDestination.destination, to: argument1, why: 'Move rhs to argument1' },
                { kind: 'call', function: 'length', why: 'Compute the length of rhs and add it to length temporary' },
                add({
                    l: functionResult,
                    r: newStringLengthTemporary.destination,
                    to: newStringLengthTemporary.destination,
                }),
                {
                    kind: 'move',
                    from: newStringLengthTemporary.destination,
                    to: argument1,
                    why: 'Move new string length to argument1',
                },
                { kind: 'call', function: 'my_malloc', why: 'Malloc that much space' },
                {
                    kind: 'move',
                    from: functionResult,
                    to: mallocResultTemporary.destination,
                    why: 'Move malloc result to temporary',
                },
                { kind: 'move', from: leftSideDestination.destination, to: argument1, why: 'Move lhs to argument1' },
                { kind: 'move', from: rightSideDestination.destination, to: argument2, why: 'Move rhs to argument2' },
                {
                    kind: 'move',
                    from: mallocResultTemporary.destination,
                    to: argument3,
                    why: 'Move destintion to argument3',
                },
                {
                    kind: 'call',
                    function: 'string_concatenate',
                    why: 'Concatenate the strings and write to malloced space',
                },
                {
                    kind: 'move',
                    from: mallocResultTemporary.destination,
                    to: destination.destination,
                    why: 'Move new string pointer to final destination',
                },
            ]);
        }
        default:
            throw debug('todo');
    }
};

const assignMipsRegisters = (
    variables: VariableDeclaration[]
): { registerAssignment: RegisterAssignment; firstTemporary: StorageSpec } => {
    // TODO: allow spilling of variables
    let currentRegister = 0;
    let registerAssignment = {};
    variables.forEach(variable => {
        registerAssignment[variable.name] = {
            type: 'register',
            destination: `$t${currentRegister}`,
        };
        currentRegister = currentRegister + 1;
    });
    return {
        registerAssignment,
        firstTemporary: {
            type: 'register',
            destination: `$t${currentRegister}`,
        },
    };
};

const saveRegistersCode = (numRegisters: number): string[] => {
    let result = [`# Always store return address`, `sw $ra, ($sp)`, `addiu $sp, $sp, -4`];
    while (numRegisters > 0) {
        result.push(`sw $t${numRegisters}, ($sp)`);
        result.push(`addiu $sp, $sp, -4`);
        numRegisters--;
    }
    return result;
};

const restoreRegistersCode = (numRegisters: number): string[] => {
    let result = [`lw $ra, ($sp)`, `addiu $sp, $sp, 4`, `# Always restore return address`];
    while (numRegisters > 0) {
        result.push(`lw $t${numRegisters}, ($sp)`);
        result.push(`addiu $sp, $sp, 4`);
        numRegisters--;
    }
    return result.reverse();
};

const registerTransferExpressionToMipsWithoutComment = (rtx: PureRegisterTransferLanguageExpression): string => {
    switch (rtx.kind) {
        case 'comment':
            return '';
        case 'syscall':
            return 'syscall';
        case 'move':
            return `move ${rtx.to}, ${rtx.from}`;
        case 'loadImmediate':
            switch (rtx.destination.type) {
                case 'register':
                    return `li ${rtx.destination.destination}, ${rtx.value}`;
                // TODO: use a register allocator
                case 'memory':
                    return [`li $s7, ${rtx.value}`, `sw $s7, -${rtx.destination.spOffset}($sp)`].join('\n');
                default:
                    throw debug('todo');
            }
        case 'addImmediate':
            return `addiu ${rtx.register}, ${rtx.amount}`;
        case 'returnValue':
            if (rtx.source.type !== 'register') throw debug('todo');
            return `move ${functionResult}, ${rtx.source.destination}`;
        case 'subtract':
            if (rtx.lhs.type !== 'register') throw debug('todo');
            if (rtx.rhs.type !== 'register') throw debug('todo');
            if (rtx.destination.type !== 'register') throw debug('todo');
            return `sub ${rtx.destination.destination}, ${rtx.lhs.destination}, ${rtx.rhs.destination}`;
        case 'increment':
            return `addiu ${rtx.register}, ${rtx.register}, 1`;
        case 'label':
            return `L${rtx.name}:`;
        case 'functionLabel':
            return `${rtx.name}:`;
        case 'goto':
            return `b L${rtx.label}`;
        case 'gotoIfEqual':
            if (rtx.lhs.type !== 'register' || rtx.rhs.type !== 'register') throw debug('todo');
            return `beq ${rtx.lhs.destination}, ${rtx.rhs.destination}, L${rtx.label}`;
        case 'gotoIfNotEqual':
            return `bne ${rtx.lhs}, ${rtx.rhs}, L${rtx.label}`;
        case 'gotoIfZero':
            return `beq ${rtx.register}, 0, L${rtx.label}`;
        case 'gotoIfGreater':
            return `bgt ${rtx.lhs}, ${rtx.rhs}, L${rtx.label}`;
        case 'loadSymbolAddress':
            if (rtx.to.type !== 'register') throw debug('todo');
            return `la ${rtx.to.destination}, ${rtx.symbolName}`;
        case 'loadGlobal':
            if (rtx.to.type !== 'register') throw debug('todo');
            return `lw ${rtx.to.destination}, ${rtx.from}`;
        case 'storeGlobal':
            return `sw ${rtx.from}, ${rtx.to}`;
        case 'loadMemory':
            if (rtx.to.type !== 'register') throw debug('todo');
            if (rtx.from.type !== 'register') throw debug('todo');
            return `lw ${rtx.to.destination}, ${rtx.offset}(${rtx.from.destination})`;
        case 'storeMemory':
            return `sw ${rtx.from}, ${rtx.offset}(${rtx.address})`;
        case 'call':
            return `jal ${rtx.function}`;
        case 'returnToCaller':
            return `jr $ra`;
        default:
            throw debug(`${(rtx as any).kind} unhandled in registerTransferExpressionToMipsWithoutComment`);
    }
};

const registerTransferExpressionToMips = (rtx: RegisterTransferLanguageExpression): string => {
    if (typeof rtx == 'string') return rtx;
    return `${registerTransferExpressionToMipsWithoutComment(rtx)} # ${rtx.why}`;
};

const lengthRuntimeFunction = (): RegisterTransferLanguageExpression[] => {
    const currentChar = '$t1';
    return [
        `length:`,
        ...saveRegistersCode(1),
        {
            kind: 'loadImmediate',
            destination: { type: 'register', destination: functionResult },
            value: 0,
            why: 'Set length count to 0',
        },
        `length_loop:`,
        `# Load char into temporary`,
        `lb ${currentChar}, (${argument1})`,
        {
            kind: 'gotoIfZero',
            register: currentChar,
            label: 'length_return',
            why: 'If char is null, end of string. Return count.',
        },
        { kind: 'increment', register: functionResult, why: 'Bump string index' },
        { kind: 'increment', register: argument1, why: 'Bump length counter' },
        `b length_loop`,
        { kind: 'label', name: 'length_return', why: 'Done' },
        ...restoreRegistersCode(1),
        `jr $ra,`,
    ];
};

const syscallNumbers = {
    print: 4,
    sbrk: 9,
    exit: 10,
};

const printRuntimeFunction = (): PureRegisterTransferLanguageExpression[] => {
    return [
        { kind: 'functionLabel', name: 'print', why: 'Print: string->' },
        {
            kind: 'loadImmediate',
            destination: { type: 'register', destination: syscallSelect },
            value: syscallNumbers.print,
            why: 'Select print',
        },
        { kind: 'move', to: syscallArg1, from: argument1, why: 'Move print argument to syscall argument' },
        { kind: 'syscall', why: 'Print' },
        { kind: 'move', from: syscallResult, to: functionResult, why: 'Move syscall result to function result' },
        { kind: 'returnToCaller', why: 'Return' },
    ];
};

const stringEqualityRuntimeFunction = (): RegisterTransferLanguageExpression[] => {
    const leftByte = '$t1';
    const rightByte = '$t2';
    return [
        `stringEquality:`,
        ...saveRegistersCode(2),
        `# Assume equal. Write 1 to $a0. Overwrite if difference found.`,
        `li ${functionResult}, 1`,
        { kind: 'label', name: 'stringEquality_loop', why: 'Check a char, (string*, string*) -> bool' },
        `# load current chars into temporaries`,
        `lb ${leftByte}, (${argument1})`,
        `lb ${rightByte}, (${argument2})`,
        `# Inequal: return false`,
        `bne ${leftByte}, ${rightByte}, stringEquality_return_false`,
        {
            kind: 'gotoIfZero',
            register: leftByte,
            label: 'stringEquality_return',
            why: 'Both side are equal. If both sides are null, return.',
        },
        { kind: 'increment', register: argument1, why: 'Bump lhs to next char' },
        { kind: 'increment', register: argument2, why: 'Bump rhs to next char' },
        { kind: 'goto', label: 'stringEquality_loop', why: 'Check next char' },
        `stringEquality_return_false:`,
        `li ${functionResult}, 0`,
        { kind: 'label', name: 'stringEquality_return', why: '' },
        ...restoreRegistersCode(2),
        `jr $ra`,
    ];
};

const stringCopyRuntimeFunction = (): RegisterTransferLanguageExpression[] => {
    const currentChar = '$t1';
    return [
        `string_copy:`,
        ...saveRegistersCode(1),
        `# load byte from input`,
        `string_copy_loop:`,
        `lb ${currentChar}, (${argument1})`,
        `# write it to argument 2`,
        `sb ${currentChar}, (${argument2})`,
        {
            kind: 'gotoIfZero',
            register: currentChar,
            label: 'string_copy_return',
            why: 'If char was the null terminator, return',
        },
        `# Else, bump the pointers so we copy the next char, and copy copy the next char`,
        `addiu ${argument1}, ${argument1}, 1`,
        `addiu ${argument2}, ${argument2}, 1`,
        `b string_copy_loop`,
        { kind: 'label', name: 'string_copy_return', why: '' },
        ...restoreRegistersCode(1),
        `jr $ra`,
    ];
};

const stringConcatenateRuntimeFunction = (): RegisterTransferLanguageExpression[] => {
    const left = argument1;
    const right = argument2;
    const out = argument3;
    const currentChar = '$t1';
    return [
        `string_concatenate:`,
        ...saveRegistersCode(1),
        `# Load byte from left`,
        `write_left_loop:`,
        `lb ${currentChar}, (${left}),`,
        {
            kind: 'gotoIfZero',
            register: currentChar,
            label: 'copy_from_right',
            why: 'If found lefts null terminator, start copying right',
        },
        `# Else, write to out, bump pointers, and loop`,
        `sb ${currentChar}, (${out})`,
        `addiu ${left}, ${left}, 1`,
        `addiu ${out}, ${out}, 1`,
        `b write_left_loop`,
        { kind: 'label', name: 'copy_from_right', why: '' },
        `lb ${currentChar}, (${right})`,
        `# always write (to get null terminator)`,
        `sb ${currentChar}, (${out})`,
        {
            kind: 'gotoIfZero',
            register: currentChar,
            label: 'concatenate_return',
            why: 'If we just wrote a null terminator, we are done',
        },
        `# Else bump pointers and loop`,
        `addiu ${right}, ${right}, 1`,
        `addiu ${out}, ${out}, 1,`,
        { kind: 'goto', label: 'copy_from_right', why: 'Go copy next char' },
        { kind: 'label', name: 'concatenate_return', why: '' },
        ...restoreRegistersCode(1),
        `jr $ra`,
    ];
};

const bytesInWord = 4;

const myFreeRuntimeFunction = (): RegisterTransferLanguageExpression[] => {
    const one = '$t1';
    return [
        `my_free:`,
        ...saveRegistersCode(1),
        `bne ${argument1}, 0, free_null_check_passed`,
        `la $a0, ${errors.freeNull.name}`,
        `li $v0, 4`,
        `syscall`,
        `li $v0, 10`,
        `syscall`,
        `free_null_check_passed:`,
        `# TODO: merge blocks`,
        `# TODO: check if already free`,
        `li ${one}, 1,`,
        { kind: 'storeMemory', from: one, address: argument1, offset: -1 * bytesInWord, why: 'block->free = false' },
        ...restoreRegistersCode(1),
        `jr $ra`,
    ];
};

const verifyNoLeaks = (): RegisterTransferLanguageExpression[] => {
    const currentBlockPointer = '$t1';
    const currentData = '$t2';
    return [
        `verify_no_leaks:`,
        ...saveRegistersCode(2),
        `la ${currentBlockPointer}, first_block`,
        `lw ${currentBlockPointer}, (${currentBlockPointer})`,
        `verify_no_leaks_loop:`,
        { kind: 'gotoIfZero', register: currentBlockPointer, label: 'verify_no_leaks_return', why: '' },
        `lw ${currentData}, ${2 * bytesInWord}(${currentBlockPointer})`,
        `bne ${currentData}, 0, verify_no_leaks_advance_pointers`,
        `la $a0, ${errors.leaksDetected.name}`,
        `li $v0, 4`,
        `syscall`,
        `li $v0, 10`,
        `syscall`,
        `verify_no_leaks_advance_pointers:`,
        `lw ${currentBlockPointer}, ${1 * bytesInWord}(${currentBlockPointer})`,
        `b verify_no_leaks_loop`,
        { kind: 'label', name: 'verify_no_leaks_return', why: '' },
        ...restoreRegistersCode(2),
        `jr $ra`,
    ];
};

const stringLiteralDeclaration = (literal: StringLiteralData) =>
    `${stringLiteralName(literal)}: .asciiz "${literal.value}"`;

const runtimeFunctions: RegisterTransferLanguageExpression[][] = [
    lengthRuntimeFunction(),
    printRuntimeFunction(),
    stringEqualityRuntimeFunction(),
    stringCopyRuntimeFunction(),
    malloc(
        bytesInWord,
        syscallNumbers,
        saveRegistersCode,
        restoreRegistersCode,
        knownRegisters,
        firstRegister,
        nextTemporary
    ),
    myFreeRuntimeFunction(),
    stringConcatenateRuntimeFunction(),
    verifyNoLeaks(),
];

const toExectuable = ({ functions, program, globalDeclarations, stringLiterals }: BackendInputs) => {
    let mipsFunctions = functions.map(f =>
        constructFunction(
            f,
            astToMips,
            globalDeclarations,
            stringLiterals,
            functionResult,
            [argument1, argument2, argument3],
            firstRegister,
            nextTemporary,
            saveRegistersCode,
            restoreRegistersCode
        )
    );
    const { registerAssignment, firstTemporary } = assignMipsRegisters(program.variables);
    let mipsProgram = flatten(
        program.statements.map(statement => {
            const compiledProgram = astToMips({
                ast: statement,
                registerAssignment,
                destination: {
                    type: 'register',
                    destination: '$a0',
                },
                currentTemporary: firstTemporary,
                globalDeclarations,
                stringLiterals,
            });

            return [...compiledProgram.prepare, ...compiledProgram.execute, ...compiledProgram.cleanup];
        })
    );

    const freeGlobals: PureRegisterTransferLanguageExpression[] = flatten(
        globalDeclarations.filter(declaration => declaration.type.name === 'String').map(declaration => [
            {
                kind: 'loadGlobal',
                from: declaration.name,
                to: { type: 'register', destination: argument1 },
                why: 'Load global string so we can free it',
            } as PureRegisterTransferLanguageExpression,
            {
                kind: 'call',
                function: 'my_free',
                why: 'Free gloabal string at end of program',
            } as PureRegisterTransferLanguageExpression,
        ])
    );

    // Create space for spilled tempraries
    const numSpilledTemporaries = program.temporaryCount - 10;
    const makeSpillSpaceCode =
        numSpilledTemporaries > 0
            ? [`# Make spill space for main program`, `addiu $sp, $sp, -${numSpilledTemporaries * 4}`]
            : [];
    const removeSpillSpaceCode =
        numSpilledTemporaries > 0
            ? [`# Clean spill space for main program`, `addiu $sp, $sp, ${numSpilledTemporaries * 4}`]
            : [];

    return `
.data
${globalDeclarations.map(name => `${name.name}: .word 0`).join('\n')}
${stringLiterals.map(stringLiteralDeclaration).join('\n')}
${Object.keys(errors)
        .map(key => `${errors[key].name}: .asciiz "${errors[key].value}"`)
        .join('\n')}

# First block pointer. Block: size, next, free
first_block: .word 0

.text
${join(flatten(runtimeFunctions).map(registerTransferExpressionToMips), '\n')}

${join(flatten(mipsFunctions).map(registerTransferExpressionToMips), '\n')}
main:
${makeSpillSpaceCode.join('\n')}
${join(mipsProgram.map(registerTransferExpressionToMips), '\n')}
${removeSpillSpaceCode.join('\n')}
${join(freeGlobals.map(registerTransferExpressionToMips), '\n')}
${registerTransferExpressionToMips({ kind: 'call', function: ' verify_no_leaks', why: 'Check for leaks' })}
# print "exit code" and exit
li $v0, 1
syscall
li $v0, 10
syscall`;
};

const execute = async (path: string): Promise<ExecutionResult> => {
    // This string is always printed with spim starts. Strip it from stdout. TODO: Look in to MARS, maybe it doesn't do this?
    const exceptionsLoadedPreamble = 'Loaded: /usr/local/Cellar/spim/9.1.17/share/exceptions.s\n';
    try {
        const result = await exec(`spim -file ${path}`);
        if (result.stderr !== '') {
            return { error: `Spim error: ${result.stderr}` };
        }
        const trimmedStdout = result.stdout.slice(exceptionsLoadedPreamble.length);
        const lines = trimmedStdout.split('\n');
        const mipsExitCode = parseInt(lines[lines.length - 1].match(/[0-9]*$/)[0]);
        return {
            exitCode: mipsExitCode,
            stdout: trimmedStdout.slice(0, trimmedStdout.length - mipsExitCode.toString().length),
        };
    } catch (e) {
        return {
            error: `Exception: ${e.message}`,
        };
    }
};

export default {
    name: 'mips',
    toExectuable,
    execute,
    debug: path => exec(`${__dirname}/../../QtSpim.app/Contents/MacOS/QtSpim ${path}`),
};
