import { errors } from '../runtime-strings.js';
import debug from '../util/debug.js';
import { Register } from '../register.js';
import { ThreeAddressFunction } from './threeAddressCode.js';

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
                rhs: { name: '-1' }, // TODO: should be immediate
                label: 'alloc_exit_check_passed',
                why: 'If mmap failed, exit',
            },
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
                rhs: { name: '0' },
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

export const length: RuntimeFunctionGenerator = bytesInWord => {
    const currentChar = { name: 'currentChar' };
    return {
        name: 'length',
        isMain: false,
        instructions: [
            {
                kind: 'loadImmediate',
                destination: 'functionResult',
                value: 0,
                why: 'Set length count to 0',
            },
            { kind: 'label', name: 'length_loop', why: 'Count another charachter' },
            {
                kind: 'loadMemoryByte',
                address: 'functionArgument1',
                to: currentChar,
                why: 'Load char into memory',
            },
            {
                kind: 'gotoIfZero',
                register: currentChar,
                label: 'length_return',
                why: 'If char is null, end of string. Return count.',
            },
            { kind: 'increment', register: 'functionResult', why: 'Bump string index' },
            { kind: 'increment', register: 'functionArgument1', why: 'Bump length counter' },
            { kind: 'goto', label: 'length_loop', why: 'Go count another char' },
            { kind: 'label', name: 'length_return', why: 'Done' },
            {
                kind: 'subtract',
                lhs: 'functionArgument1',
                rhs: 'functionResult',
                destination: 'functionArgument1',
                why: 'Repair pointer passed in arg1 so caller can still use it',
            },
        ],
    };
};

export const stringCopy: RuntimeFunctionGenerator = bytesInWord => {
    const currentChar = { name: 'currentChar' };
    return {
        name: 'string_copy',
        isMain: false,
        instructions: [
            { kind: 'label', name: 'string_copy_loop', why: 'Copy a byte' },
            {
                kind: 'loadMemoryByte',
                to: currentChar,
                address: 'functionArgument1',
                why: 'Load byte from input',
            },
            {
                kind: 'storeMemoryByte',
                contents: currentChar,
                address: 'functionArgument2',
                why: 'Write it to output',
            },
            {
                kind: 'gotoIfZero',
                register: currentChar,
                label: 'string_copy_return',
                why: 'If char was the null terminator, return',
            },
            { kind: 'increment', register: 'functionArgument1', why: 'Bump pointers to next char' },
            { kind: 'increment', register: 'functionArgument2', why: 'Bump pointers to next char' },
            { kind: 'goto', label: 'string_copy_loop', why: 'Copy next char' },
            { kind: 'label', name: 'string_copy_return', why: '' },
        ],
    };
};

export const printWithPrintRuntimeFunction: RuntimeFunctionGenerator = bytesInWord => {
    return {
        name: 'print',
        isMain: false,
        instructions: [
            {
                kind: 'syscall',
                name: 'print',
                arguments: ['functionArgument1'],
                why: 'Print',
                destination: 'functionResult',
            },
        ],
    };
};

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

export const stringConcatenateRuntimeFunction: RuntimeFunctionGenerator = bytesInWord => {
    const left = 'functionArgument1';
    const right = 'functionArgument2';
    const out = 'functionArgument3';
    const currentChar = { name: 'currentChar' };
    return {
        name: 'string_concatenate',
        isMain: false,
        instructions: [
            { kind: 'label', name: 'write_left_loop', why: 'write_left_loop' },
            { kind: 'loadMemoryByte', to: currentChar, address: left, why: 'Load byte from left' },
            {
                kind: 'gotoIfZero',
                register: currentChar,
                label: 'copy_from_right',
                why: 'If found lefts null terminator, start copying right',
            },
            { kind: 'storeMemoryByte', contents: currentChar, address: out, why: 'Write byte to output' },
            { kind: 'increment', register: left, why: 'Bump left pointer' },
            { kind: 'increment', register: out, why: 'Bump out pointer' },
            { kind: 'goto', label: 'write_left_loop', why: 'Loop to next char' },
            { kind: 'label', name: 'copy_from_right', why: 'copy_from_right' },
            { kind: 'loadMemoryByte', to: currentChar, address: right, why: 'Load byte from right' },
            {
                kind: 'storeMemoryByte',
                contents: currentChar,
                address: out,
                why: 'Write before checking for null terminator because we want to write null terminator',
            },
            {
                kind: 'gotoIfZero',
                register: currentChar,
                label: 'concatenate_return',
                why: 'If we just wrote a null terminator, we are done',
            },
            { kind: 'increment', register: right, why: 'Bump right pointer' },
            { kind: 'increment', register: out, why: 'Bump out pointer' },
            { kind: 'goto', label: 'copy_from_right', why: 'Go copy next char' },
            { kind: 'label', name: 'concatenate_return', why: '' },
        ],
    };
};

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
