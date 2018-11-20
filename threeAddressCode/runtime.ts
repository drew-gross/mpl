import { errors } from '../runtime-strings.js';
import debug from '../util/debug.js';
import { Register } from '../register.js';
import { ThreeAddressFunction, ThreeAddressStatement } from './generator.js';
import tacToString from './programToString.js';
import parseTac from './parser.js';

export type RuntimeFunctionGenerator = (bytesInWord: number) => ThreeAddressFunction;

const switchableMallocImpl = (
    bytesInWord,
    include: 'include curr = *curr' | 'dont include curr = *curr',
    makeSyscall
) => {
    const currentBlockPointer = { name: 'currentBlockPointer' };
    const previousBlockPointer = { name: 'previousBlockPointer' };
    const currentBlockIsFree = { name: 'current_block_is_free' };
    const zero = { name: 'zero' };
    const err = { name: 'err' };
    return {
        name: 'my_malloc',
        isMain: false,
        instructions: [
            {
                kind: 'loadImmediate',
                value: 0,
                destination: zero,
                why: 'need a zero',
            },
            {
                kind: 'gotoIfGreater',
                lhs: 'functionArgument1',
                rhs: zero,
                label: 'my_malloc_zero_size_check_passed',
                why: 'Error if no memory requested',
            },
            {
                kind: 'loadSymbolAddress',
                symbolName: errors.allocatedZero.name,
                to: err,
                why: 'Error to print',
            },
            {
                kind: 'syscall',
                name: 'print',
                arguments: [err],
                why: 'Print',
                destination: undefined,
            },
            {
                kind: 'syscall',
                name: 'exit',
                arguments: [-1],
                why: 'Exit',
                destination: undefined,
            },
            { kind: 'label', name: 'my_malloc_zero_size_check_passed', why: 'Done checking for zero size' },
            {
                kind: 'loadSymbolAddress',
                symbolName: 'first_block',
                to: currentBlockPointer,
                why: 'curr = &first_block',
            },
            // TODO: something weird is going on here. For some reason, x64 backend requires this line, and mips doesn't. TODO: figure out what is right.
            ...(include == 'include curr = *curr'
                ? [
                      {
                          kind: 'loadMemory',
                          from: currentBlockPointer,
                          to: currentBlockPointer,
                          offset: 0,
                          why: 'curr = *curr',
                      },
                  ]
                : []),
            {
                kind: 'loadImmediate',
                destination: previousBlockPointer,
                value: 0,
                why: 'prev = NULL',
            },
            { kind: 'label', name: 'find_large_enough_free_block_loop', why: 'Find a block' },
            {
                kind: 'gotoIfZero',
                register: currentBlockPointer,
                label: 'found_large_enough_block',
                why: 'No blocks left (will require syscall)',
            },
            {
                kind: 'loadMemory',
                to: currentBlockIsFree,
                from: currentBlockPointer,
                offset: 2 * bytesInWord,
                why: 'Current block not free, load next block',
            },
            {
                kind: 'gotoIfZero',
                register: currentBlockIsFree,
                label: 'advance_pointers',
                why: 'Check next block',
            },
            {
                kind: 'loadMemory',
                to: { name: 'current_bock_size' },
                from: currentBlockPointer,
                offset: 0,
                why: 'Current block not large enough, try next',
            },
            {
                kind: 'gotoIfGreater',
                lhs: { name: 'current_bock_size' },
                rhs: 'functionArgument1',
                label: 'advance_pointers',
                why: 'Check next block if current not large enough',
            },
            {
                kind: 'goto',
                label: 'found_large_enough_block',
                why: 'We found a large enough block! Hooray!',
            },
            { kind: 'label', name: 'advance_pointers', why: 'Bump pointers to next block' },
            {
                kind: 'move',
                to: previousBlockPointer,
                from: currentBlockPointer,
                why: 'prev = curr',
            },
            {
                kind: 'loadMemory',
                to: currentBlockPointer,
                from: currentBlockPointer,
                offset: 1 * bytesInWord,
                why: 'curr = curr->next',
            },
            { kind: 'goto', label: 'find_large_enough_free_block_loop', why: "Didn't find a block, try again" },
            { kind: 'label', name: 'found_large_enough_block', why: 'Found a block' },
            {
                kind: 'gotoIfZero',
                register: currentBlockPointer,
                label: 'sbrk_more_space',
                why: 'No good blocks, so make one',
            },
            {
                kind: 'storeZeroToMemory',
                address: currentBlockPointer,
                offset: 2 * bytesInWord,
                why: 'block->free = false',
            },
            {
                kind: 'move',
                to: 'functionResult',
                from: currentBlockPointer,
                why: 'Return current block pointer',
            },
            {
                kind: 'addImmediate',
                register: 'functionResult',
                amount: 3 * bytesInWord,
                why: 'Adjust pointer to point to allocated space instead of management struct',
            },
            { kind: 'goto', label: 'my_malloc_return', why: 'Found good existing block' },
            { kind: 'label', name: 'sbrk_more_space', why: 'Here we sbrk a new block' },
            {
                kind: 'addImmediate',
                amount: 3 * bytesInWord,
                register: 'functionArgument1',
                why: 'Add space for management block',
            },
            makeSyscall('functionArgument1', 'functionResult'),
            {
                kind: 'addImmediate',
                register: 'functionArgument1',
                amount: -3 * bytesInWord,
                why: 'Repair arg 1 after adding management block length to it',
            },
            {
                kind: 'gotoIfNotEqual',
                lhs: 'functionResult',
                rhs: -1,
                label: 'alloc_exit_check_passed',
                why: 'If mmap failed, exit',
            } as ThreeAddressStatement,
            {
                kind: 'loadSymbolAddress',
                to: err,
                symbolName: errors.allocationFailed.name,
                why: 'Load string to print',
            },
            {
                kind: 'syscall',
                name: 'print',
                arguments: [err],
                why: 'Print',
                destination: undefined,
            },
            {
                kind: 'syscall',
                name: 'exit',
                arguments: [-1],
                why: 'Exit',
                destination: undefined,
            },
            {
                kind: 'label',
                name: 'alloc_exit_check_passed',
                why: 'functionResult now contains pointer to block. Set up pointer to new block.',
            },
            {
                kind: 'loadGlobal',
                from: 'first_block',
                to: { name: 'first_block_pointer_address' },
                why: 'Load first block so we can write to it if necessary',
            },
            {
                kind: 'gotoIfNotEqual',
                lhs: { name: 'first_block_pointer_address' },
                rhs: 0,
                label: 'assign_previous',
                why: 'If there is no previous block, set up first block pointer',
            },
            {
                kind: 'storeGlobal',
                from: 'functionResult',
                to: 'first_block',
                why: 'Setup first block pointer',
            },
            { kind: 'goto', label: 'set_up_new_space', why: '' },
            { kind: 'label', name: 'assign_previous', why: 'Set up prevous block pointer' },
            { kind: 'gotoIfZero', register: previousBlockPointer, label: 'set_up_new_space', why: '' },
            {
                kind: 'storeMemory',
                from: 'functionResult',
                address: previousBlockPointer,
                offset: 0,
                why: 'prev->next = new',
            },
            { kind: 'label', name: 'set_up_new_space', why: '' },
            {
                kind: 'storeMemory',
                from: 'functionArgument1',
                address: 'functionResult',
                offset: 0,
                why: 'new->size = requested_size',
            },
            {
                kind: 'storeZeroToMemory',
                address: 'functionResult',
                offset: 1 * bytesInWord,
                why: 'new->next = null',
            },
            {
                kind: 'storeZeroToMemory',
                address: 'functionResult',
                offset: 2 * bytesInWord,
                why: 'new->free = false',
            },
            {
                kind: 'addImmediate',
                register: 'functionResult',
                amount: 3 * bytesInWord,
                why: 'Adjust result pointer to point to actuall space, not management block',
            },
            { kind: 'label', name: 'my_malloc_return', why: 'Done' },
        ],
    };
};

export const mallocWithSbrk: RuntimeFunctionGenerator = bytesInWord => {
    return switchableMallocImpl(bytesInWord, 'dont include curr = *curr', (amount, destination) => ({
        kind: 'syscall',
        name: 'sbrk',
        arguments: [amount],
        why: 'sbrk',
        destination: destination,
    }));
};

export const mallocWithMmap: RuntimeFunctionGenerator = bytesInWord => {
    return switchableMallocImpl(bytesInWord, 'include curr = *curr', (amount, destination) => ({
        kind: 'syscall',
        name: 'mmap',
        arguments: [
            0, // addr, use null
            amount,
            3, // prot arg, 3 = PROT_READ|PROT_WRITE
            0x1002, // flags arg, 0x1002 = MAP_ANON | MAP_PRIVATE (according to dtruss)
            -1, // fd arg, unused, set to -1 just in case
            0, // offset arg, unused, set to 0
        ],
        why: 'mmap',
        destination: destination,
    }));
};

export const length: RuntimeFunctionGenerator = bytesInWord =>
    (parseTac(`
    (function) length:
            r:functionResult = 0 # Result = 0
        length_loop: # Count another charachter
            r:currentChar = *r:functionArgument1 # Load next byte
            goto length_return if r:currentChar == 0 # If it's null, we are done
            r:functionResult++ # Bump string index
            r:functionArgument1++ # Bump length counter
            goto length_loop # Go count another char
        length_return: # Done
            r:functionArgument1 = r:functionArgument1 - r:functionResult # Repair input pointer
    `) as any).functions[0];

export const stringCopy: RuntimeFunctionGenerator = bytesInWord =>
    (parseTac(`
    (function) string_copy: # Copy string pointer to by first argument to second argument
        string_copy_loop: # Copy a byte
            r:currentChar = *r:functionArgument1 # Load next char from string
            *r:functionArgument2 = r:currentChar # Write char to output
            goto string_copy_return if r:currentChar == 0 # If at end, return
            r:functionArgument1++ # Else increment to next char
            r:functionArgument2++ # Increment output too
            goto string_copy_loop # and go keep copying
        string_copy_return: # Done
    `) as any).functions[0];

export const printWithPrintRuntimeFunction: RuntimeFunctionGenerator = bytesInWord =>
    (parseTac(`
    (function) print:
        syscalld print r:functionResult r:functionArgument1 # Print the thing
    `) as any).functions[0];

export const printWithWriteRuntimeFunction: RuntimeFunctionGenerator = bytesInWord => {
    return {
        name: 'print',
        isMain: false,
        instructions: [
            {
                kind: 'callByName',
                function: 'length',
                why:
                    'Call length on argument so we can pass it to write(2). (Arugment is already in argument register)',
            },
            {
                kind: 'syscall',
                name: 'print',
                arguments: [
                    1, // Load stdout fd into argument 1 of write(2) (stdout fd is 1)
                    'functionArgument1', // Put string ptr in arg 2 of write(2)
                    'functionResult', // 3rd argument to write(2) is length
                ],
                why: 'Print',
                destination: 'functionResult',
            },
        ],
    };
};

// TODO: figure out a way to verify that this is working
export const verifyNoLeaks: RuntimeFunctionGenerator = bytesInWord => {
    const currentBlockPointer = { name: 'currentBlockPointer' };
    const currentData = { name: 'currentData' };
    const err = { name: 'err' };
    const one = { name: 'one' };
    return {
        name: 'verify_no_leaks',
        isMain: false,
        instructions: [
            {
                kind: 'loadSymbolAddress',
                symbolName: 'first_block',
                to: currentBlockPointer,
                why: 'Load first block address',
            },
            {
                kind: 'loadMemory',
                from: currentBlockPointer,
                to: currentBlockPointer,
                offset: 0,
                why: 'Load first block pointer',
            },
            { kind: 'label', name: 'verify_no_leaks_loop', why: 'verify_no_leaks_loop' },
            { kind: 'gotoIfZero', register: currentBlockPointer, label: 'verify_no_leaks_return', why: '' },
            {
                kind: 'loadMemory',
                to: currentData,
                from: currentBlockPointer,
                offset: 2 * bytesInWord,
                why: 'data = block->free',
            },
            {
                kind: 'loadImmediate',
                destination: one,
                value: 1,
                why: 'Need for comparison',
            },
            {
                kind: 'gotoIfEqual',
                lhs: currentData,
                rhs: one,
                label: 'verify_no_leaks_advance_pointers',
                why: "Don't error if free",
            },
            {
                kind: 'loadSymbolAddress',
                to: err,
                symbolName: errors.leaksDetected.name,
                why: 'Error to print',
            },
            {
                kind: 'syscall',
                name: 'print',
                arguments: [err],
                why: 'syscall',
                destination: undefined,
            },
            {
                kind: 'syscall',
                name: 'exit',
                arguments: [-1],
                why: 'syscall',
                destination: undefined,
            },
            { kind: 'label', name: 'verify_no_leaks_advance_pointers', why: 'verify_no_leaks_advance_pointers' },
            {
                kind: 'loadMemory',
                to: currentBlockPointer,
                from: currentBlockPointer,
                offset: 1 * bytesInWord,
                why: 'block = block->next',
            },
            { kind: 'goto', label: 'verify_no_leaks_loop', why: 'Check next block' },
            { kind: 'label', name: 'verify_no_leaks_return', why: '' },
        ],
    };
};

export const stringConcatenateRuntimeFunction: RuntimeFunctionGenerator = bytesInWord =>
    (parseTac(`
    (function) string_concatenate:
        write_left_loop: # Append left string
            r:currentChar = *r:functionArgument1 # Load byte from left
            goto copy_from_right if r:currentChar == 0 # If end of left, start copying right
            *r:functionArgument3 = r:currentChar # Write byte from left
            r:functionArgument1++ # Bump left pointer
            r:functionArgument3++ # Bump out pointer
            goto write_left_loop # Loop to next char
        copy_from_right: # Append right string
            r:currentChar = *r:functionArgument2 # Load byte from right
            *r:functionArgument3 = r:currentChar # Copy right byte (incl. null)
            goto concatenate_return if r:currentChar == 0 # If we just wrote null, we are done
            r:functionArgument2++ # Bump right pointer
            r:functionArgument3++ # Bump out pointer
            goto copy_from_right # Go copy next char
        concatenate_return: # Exit. TODO: repair input pointers?
    `) as any).functions[0];

export const stringEqualityRuntimeFunction: RuntimeFunctionGenerator = bytesInWord => {
    const leftByte = { name: 'leftByte' };
    const rightByte = { name: 'rightByte' };
    return {
        name: 'stringEquality',
        isMain: false,
        instructions: [
            {
                kind: 'loadImmediate',
                destination: 'functionResult',
                value: 1,
                why: 'Assume equal. Write true to functionResult. Overwrite if difference found.',
            },
            { kind: 'label', name: 'stringEquality_loop', why: 'Check a char, (string*, string*) -> bool' },
            {
                kind: 'loadMemoryByte',
                to: leftByte,
                address: 'functionArgument1',
                why: 'Load current left char into temporary',
            },
            {
                kind: 'loadMemoryByte',
                to: rightByte,
                address: 'functionArgument2',
                why: 'Load current right char into temporary',
            },
            {
                kind: 'gotoIfNotEqual',
                lhs: leftByte,
                rhs: rightByte,
                label: 'stringEquality_return_false',
                why: 'Inequal: return false',
            },
            {
                kind: 'gotoIfZero',
                register: leftByte,
                label: 'stringEquality_return',
                why: 'Both side are equal. If both sides are null, return.',
            },
            { kind: 'increment', register: 'functionArgument1', why: 'Bump lhs to next char' },
            { kind: 'increment', register: 'functionArgument2', why: 'Bump rhs to next char' },
            { kind: 'goto', label: 'stringEquality_loop', why: 'Check next char' },
            { kind: 'label', name: 'stringEquality_return_false', why: 'stringEquality_return_false' },
            { kind: 'loadImmediate', destination: 'functionResult', value: 0, why: 'Set result to false' },
            { kind: 'label', name: 'stringEquality_return', why: '' },
        ],
    };
};

export const myFreeRuntimeFunction: RuntimeFunctionGenerator = bytesInWord => {
    const zero = { name: 'zero' };
    const one = { name: 'one' };
    const err = { name: 'err' };
    const managementBlockSize = { name: 'managementBlockSize' };
    return {
        name: 'my_free',
        isMain: false,
        instructions: [
            { kind: 'loadImmediate', destination: zero, value: 0, why: 'Need access to a 0' },
            {
                kind: 'gotoIfNotEqual',
                lhs: 'functionArgument1',
                rhs: zero,
                label: 'free_null_check_passed',
                why: 'Not freeing null check passed',
            },
            {
                kind: 'loadSymbolAddress',
                to: err,
                symbolName: errors.freeNull.name,
                why: 'Error to print',
            },
            {
                kind: 'syscall',
                name: 'print',
                arguments: [err],
                why: 'Print',
                destination: undefined,
            },
            {
                kind: 'syscall',
                name: 'exit',
                arguments: [-1],
                why: 'exit',
                destination: undefined,
            },
            { kind: 'label', name: 'free_null_check_passed', why: 'free_null_check_passed' },
            // TODO: merge blocks
            // TODO: check if already free
            { kind: 'loadImmediate', destination: one, value: 1, why: 'Need access to a 1' },
            {
                kind: 'loadImmediate',
                destination: managementBlockSize,
                value: 3 * bytesInWord,
                why: 'managementBlockSize',
            },
            {
                kind: 'subtract',
                lhs: 'functionArgument1',
                rhs: managementBlockSize,
                destination: 'functionArgument1',
                why: 'Adjust pointer to point to management struct instead of allocated space',
            },
            {
                kind: 'storeMemory',
                from: one,
                address: 'functionArgument1',
                offset: 2 * bytesInWord,
                why: 'block->free = true',
            },
        ],
    };
};

export const allRuntimeFunctions = [
    mallocWithMmap,
    mallocWithSbrk,
    length,
    stringCopy,
    printWithWriteRuntimeFunction,
    printWithPrintRuntimeFunction,
    verifyNoLeaks,
    stringConcatenateRuntimeFunction,
    stringEqualityRuntimeFunction,
    myFreeRuntimeFunction,
];
