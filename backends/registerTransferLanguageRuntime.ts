import { errors } from '../runtime-strings.js';
import debug from '../util/debug.js';
import { StorageSpec } from '../backend-utils.js';
import { RegisterTransferLanguageExpression } from './registerTransferLanguage.js';

export type KnownRegisters = {
    argument1: { type: 'register'; destination: string };
    argument2: { type: 'register'; destination: string };
    argument3: { type: 'register'; destination: string };
    functionResult: { type: 'register'; destination: string };

    syscallSelect: { type: 'register'; destination: string };
    syscallArg1: { type: 'register'; destination: string };
    syscallArg2: { type: 'register'; destination: string };
    syscallArg3: { type: 'register'; destination: string };
    syscallArg4: { type: 'register'; destination: string };
    syscallArg5: { type: 'register'; destination: string };
    syscallArg6: { type: 'register'; destination: string };
    syscallResult: { type: 'register'; destination: string };
};

type RuntimeFunctionGenerator = (
    bytesInWord: number,
    syscallNumbers: { print: number; sbrk: number; exit: number; mmap: number },
    registerSaver: (n: number) => string[],
    registerRestorer: (n: number) => string[],
    knownRegisters: KnownRegisters,
    firstRegister: StorageSpec,
    nextRegister: ((r: StorageSpec) => StorageSpec)
) => RegisterTransferLanguageExpression[];

export const mallocWithSbrk: RuntimeFunctionGenerator = (
    bytesInWord,
    syscallNumbers,
    registerSaver,
    registerRestorer,
    knownRegisters,
    firstRegister,
    nextRegister
): RegisterTransferLanguageExpression[] => {
    const currentBlockPointer = firstRegister;
    const previousBlockPointer = nextRegister(currentBlockPointer);
    const scratch = nextRegister(previousBlockPointer);
    if (currentBlockPointer.type == 'memory') throw debug('need a register');
    if (previousBlockPointer.type == 'memory') throw debug('need a register');
    if (scratch.type == 'memory') throw debug('need a register');
    return [
        { kind: 'functionLabel', name: 'my_malloc', why: 'my_malloc' },
        ...registerSaver(3),
        {
            kind: 'gotoIfNotEqual',
            lhs: knownRegisters.argument1,
            rhs: { type: 'register', destination: '0' },
            label: 'my_malloc_zero_size_check_passed',
            why: 'Error if no memory requested',
        },
        {
            kind: 'loadSymbolAddress',
            symbolName: errors.allocatedZero.name,
            to: knownRegisters.syscallArg1,
            why: 'Error to print',
        },
        {
            kind: 'loadImmediate',
            destination: knownRegisters.syscallSelect,
            value: syscallNumbers.print,
            why: 'Select print syscall',
        },
        { kind: 'syscall', why: 'Print' },
        {
            kind: 'loadImmediate',
            destination: knownRegisters.syscallSelect,
            value: syscallNumbers.exit,
            why: 'Select exit syscall',
        },
        { kind: 'syscall', why: 'Exit' },
        { kind: 'label', name: 'my_malloc_zero_size_check_passed', why: 'Done checking for zero size' },
        {
            kind: 'loadSymbolAddress',
            symbolName: 'first_block',
            to: currentBlockPointer,
            why: 'Start checking for a free block starting at the first',
        },
        {
            kind: 'loadImmediate',
            destination: previousBlockPointer,
            value: 0,
            why: 'No previous pointer yet',
        },
        { kind: 'label', name: 'find_large_enough_free_block_loop', why: 'Find a block' },
        {
            kind: 'gotoIfZero',
            register: currentBlockPointer,
            label: 'found_large_enough_block',
            why: 'No blocks left (will require sbrk)',
        },
        {
            kind: 'loadMemory',
            to: scratch,
            from: currentBlockPointer,
            offset: 2 * bytesInWord,
            why: 'Current block not free, load next block',
        },
        { kind: 'gotoIfZero', register: scratch, label: 'advance_pointers', why: 'Check next block' },
        {
            kind: 'loadMemory',
            to: scratch,
            from: currentBlockPointer,
            offset: 0,
            why: 'Current block not large enough, try next',
        },
        {
            kind: 'gotoIfGreater',
            lhs: scratch,
            rhs: knownRegisters.argument1,
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
            why: 'Advance current block pointer to previous.',
        },
        {
            kind: 'loadMemory',
            to: currentBlockPointer,
            from: currentBlockPointer,
            offset: 1 * bytesInWord,
            why: 'Advance block->next to current pointer',
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
            why: 'Found a reusable block, mark it as not free',
        },
        {
            kind: 'move',
            to: knownRegisters.functionResult,
            from: currentBlockPointer,
            why: 'Return current block pointer',
        },
        {
            kind: 'addImmediate',
            register: knownRegisters.functionResult,
            amount: 3 * bytesInWord,
            why: 'Adjust pointer to point to allocated space instead of management struct',
        },
        { kind: 'goto', label: 'my_malloc_return', why: 'Found good existing block' },
        { kind: 'label', name: 'sbrk_more_space', why: 'Here we sbrk a new block' },
        {
            kind: 'move',
            to: knownRegisters.syscallArg1,
            from: knownRegisters.argument1,
            why: 'Move amount of space to allocate to sbrk argument',
        },
        {
            kind: 'addImmediate',
            register: knownRegisters.syscallArg1,
            amount: 3 * bytesInWord,
            why: 'Include space for management block whye sbrking',
        },
        {
            kind: 'loadImmediate',
            destination: knownRegisters.syscallSelect,
            value: syscallNumbers.sbrk,
            why: 'Select sbrk syscall',
        },
        { kind: 'syscall', why: 'sbrk' },
        {
            kind: 'gotoIfNotEqual',
            lhs: knownRegisters.syscallResult,
            rhs: { type: 'register', destination: '-1' },
            label: 'sbrk_exit_check_passed',
            why: 'If sbrk failed, exit',
        },
        {
            kind: 'loadSymbolAddress',
            to: knownRegisters.syscallArg1,
            symbolName: errors.allocationFailed.name,
            why: 'Load string to print',
        },
        {
            kind: 'loadImmediate',
            destination: knownRegisters.syscallSelect,
            value: syscallNumbers.print,
            why: 'Prepare to print',
        },
        { kind: 'syscall', why: 'Print' },
        {
            kind: 'loadImmediate',
            destination: knownRegisters.syscallSelect,
            value: syscallNumbers.exit,
            why: 'Prepare to exit',
        },
        { kind: 'syscall', why: 'Exit' },
        {
            kind: 'label',
            name: 'sbrk_exit_check_passed',
            why: `${knownRegisters.syscallResult} now contains pointer to block. Set up pointer to new block.`,
        },
        {
            kind: 'loadGlobal',
            from: 'first_block',
            to: scratch,
            why: 'Load first block so we can write to it if necessary',
        },
        {
            kind: 'gotoIfNotEqual',
            lhs: scratch,
            rhs: { type: 'register', destination: '0' },
            label: 'assign_previous',
            why: 'If there is no previous block, set up first block pointer',
        },
        {
            kind: 'storeGlobal',
            from: knownRegisters.syscallResult,
            to: { type: 'register', destination: 'first_block' },
            why: 'Setup first block pointer',
        },
        { kind: 'goto', label: 'set_up_new_space', why: '' },
        { kind: 'label', name: 'assign_previous', why: 'Set up prevous block pointer' },
        { kind: 'gotoIfZero', register: previousBlockPointer, label: 'set_up_new_space', why: '' },
        {
            kind: 'storeMemory',
            from: knownRegisters.syscallResult,
            address: previousBlockPointer,
            offset: 0,
            why: 'prev->next = new',
        },
        { kind: 'label', name: 'set_up_new_space', why: '' },
        {
            kind: 'storeMemory',
            from: knownRegisters.argument1,
            address: knownRegisters.syscallResult,
            offset: 0,
            why: 'new->size = requested_size',
        },
        {
            kind: 'storeZeroToMemory',
            address: knownRegisters.syscallResult,
            offset: 1 * bytesInWord,
            why: 'new->next = null',
        },
        {
            kind: 'storeZeroToMemory',
            address: knownRegisters.syscallResult,
            offset: 2 * bytesInWord,
            why: 'new->free = false',
        },
        {
            kind: 'move',
            to: knownRegisters.functionResult,
            from: knownRegisters.syscallResult,
            why: 'Return result of sbrk',
        },
        {
            kind: 'addImmediate',
            register: knownRegisters.functionResult,
            amount: 3 * bytesInWord,
            why: 'Adjust result pointer to point to actuall space, not management block',
        },
        { kind: 'label', name: 'my_malloc_return', why: 'Done' },
        ...registerRestorer(3),
        { kind: 'returnToCaller', why: 'Done' },
    ];
};

export const mallocWithMmap: RuntimeFunctionGenerator = (
    bytesInWord,
    syscallNumbers,
    registerSaver,
    registerRestorer,
    knownRegisters,
    firstRegister,
    nextRegister
): RegisterTransferLanguageExpression[] => {
    const currentBlockPointer = firstRegister;
    const previousBlockPointer = nextRegister(currentBlockPointer);
    const scratch = nextRegister(previousBlockPointer);
    if (currentBlockPointer.type == 'memory') throw debug('need a register');
    if (previousBlockPointer.type == 'memory') throw debug('need a register');
    if (scratch.type == 'memory') throw debug('need a register');
    return [
        { kind: 'functionLabel', name: 'my_malloc', why: 'Alloc via mmap' },
        ...registerSaver(3),
        {
            kind: 'gotoIfNotEqual',
            lhs: knownRegisters.argument1,
            rhs: { type: 'register', destination: '0' },
            label: 'my_malloc_zero_size_check_passed',
            why: 'Error if no memory requested',
        },
        {
            kind: 'loadSymbolAddress',
            symbolName: errors.allocatedZero.name,
            to: knownRegisters.syscallArg1,
            why: 'Error to print',
        },
        {
            kind: 'loadImmediate',
            destination: knownRegisters.syscallSelect,
            value: syscallNumbers.print,
            why: 'Select print syscall',
        },
        { kind: 'syscall', why: 'Print' },
        {
            kind: 'loadImmediate',
            destination: knownRegisters.syscallSelect,
            value: syscallNumbers.exit,
            why: 'Select exit syscall',
        },
        { kind: 'syscall', why: 'Exit' },
        { kind: 'label', name: 'my_malloc_zero_size_check_passed', why: 'Done checking for zero size' },
        {
            kind: 'loadSymbolAddress',
            symbolName: 'first_block',
            to: currentBlockPointer,
            why: 'Start checking for a free block starting at the first',
        },
        {
            kind: 'loadImmediate',
            destination: previousBlockPointer,
            value: 0,
            why: 'No previous pointer yet',
        },
        { kind: 'label', name: 'find_large_enough_free_block_loop', why: 'Find a block' },
        {
            kind: 'gotoIfZero',
            register: currentBlockPointer,
            label: 'found_large_enough_block',
            why: 'No blocks left (will require mmap)',
        },
        {
            kind: 'loadMemory',
            to: scratch,
            from: currentBlockPointer,
            offset: 2 * bytesInWord,
            why: 'Current block not free, load next block',
        },
        { kind: 'gotoIfZero', register: scratch, label: 'advance_pointers', why: 'Check next block' },
        {
            kind: 'loadMemory',
            to: scratch,
            from: currentBlockPointer,
            offset: 0,
            why: 'Current block not large enough, try next',
        },
        {
            kind: 'gotoIfGreater',
            lhs: scratch,
            rhs: knownRegisters.argument1,
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
            why: 'Advance current block pointer to previous.',
        },
        {
            kind: 'loadMemory',
            to: currentBlockPointer,
            from: currentBlockPointer,
            offset: 1 * bytesInWord,
            why: 'Advance block->next to current pointer',
        },
        { kind: 'goto', label: 'find_large_enough_free_block_loop', why: "Didn't find a block, try again" },
        { kind: 'label', name: 'found_large_enough_block', why: 'Found a block' },
        {
            kind: 'gotoIfZero',
            register: currentBlockPointer,
            label: 'mmap_more_space',
            why: 'No good blocks, so make one',
        },
        {
            kind: 'storeZeroToMemory',
            address: currentBlockPointer,
            offset: 2 * bytesInWord,
            why: 'Found a reusable block, mark it as not free',
        },
        {
            kind: 'move',
            to: knownRegisters.functionResult,
            from: currentBlockPointer,
            why: 'Return current block pointer',
        },
        {
            kind: 'addImmediate',
            register: knownRegisters.functionResult,
            amount: 3 * bytesInWord,
            why: 'Adjust pointer to point to allocated space instead of management struct',
        },
        { kind: 'goto', label: 'my_malloc_return', why: 'Found good existing block' },
        { kind: 'label', name: 'mmap_more_space', why: 'Here we mmap a new block' },
        {
            kind: 'loadImmediate',
            value: 0,
            destination: knownRegisters.syscallArg1,
            why: 'addr arg, use null',
        },
        {
            kind: 'move',
            from: knownRegisters.argument1,
            to: knownRegisters.syscallArg2,
            why: 'len arg, amound of memory to allocate',
        },
        {
            kind: 'addImmediate',
            amount: 3 * bytesInWord,
            register: knownRegisters.syscallArg2,
            why: 'Add space for management block',
        },
        {
            kind: 'loadImmediate',
            value: 3,
            destination: knownRegisters.syscallArg3,
            why: 'prot arg, 3 = PROT_READ|PROT_WRITE',
        },
        {
            kind: 'loadImmediate',
            value: 0x1002,
            destination: knownRegisters.syscallArg4,
            why: 'flags arg, 0x1002 = MAP_ANON | MAP_PRIVATE (according to dtruss)',
        },
        {
            kind: 'loadImmediate',
            value: -1,
            destination: knownRegisters.syscallArg5,
            why: 'fd arg, unused, set to -1 just in case',
        },
        {
            kind: 'loadImmediate',
            value: 0,
            destination: knownRegisters.syscallArg6,
            why: 'offset arg, unused, set to 0',
        },
        {
            kind: 'loadImmediate',
            value: syscallNumbers.mmap,
            destination: knownRegisters.syscallSelect,
            why: 'Select malloc for calling',
        },
        { kind: 'syscall', why: 'mmap' },
        {
            kind: 'gotoIfNotEqual',
            lhs: knownRegisters.syscallResult,
            rhs: { type: 'register', destination: '-1' }, // TODO: should be immediate
            label: 'mmap_exit_check_passed',
            why: 'If mmap failed, exit',
        },
        {
            kind: 'loadSymbolAddress',
            to: knownRegisters.syscallArg1,
            symbolName: errors.allocationFailed.name,
            why: 'Load string to print',
        },
        {
            kind: 'loadImmediate',
            destination: knownRegisters.syscallSelect,
            value: syscallNumbers.print,
            why: 'Prepare to print',
        },
        { kind: 'syscall', why: 'Print' },
        {
            kind: 'loadImmediate',
            destination: knownRegisters.syscallSelect,
            value: syscallNumbers.exit,
            why: 'Prepare to exit',
        },
        { kind: 'syscall', why: 'Exit' },
        {
            kind: 'label',
            name: 'mmap_exit_check_passed',
            why: `${knownRegisters.syscallResult} now contains pointer to block. Set up pointer to new block.`,
        },
        {
            kind: 'loadGlobal',
            from: 'first_block',
            to: scratch,
            why: 'Load first block so we can write to it if necessary',
        },
        {
            kind: 'gotoIfNotEqual',
            lhs: scratch,
            rhs: { type: 'register', destination: '0' },
            label: 'assign_previous',
            why: 'If there is no previous block, set up first block pointer',
        },
        {
            kind: 'storeGlobal',
            from: knownRegisters.syscallResult,
            to: { type: 'register', destination: 'first_block' },
            why: 'Setup first block pointer',
        },
        { kind: 'goto', label: 'set_up_new_space', why: '' },
        { kind: 'label', name: 'assign_previous', why: 'Set up prevous block pointer' },
        { kind: 'gotoIfZero', register: previousBlockPointer, label: 'set_up_new_space', why: '' },
        {
            kind: 'storeMemory',
            from: knownRegisters.syscallResult,
            address: previousBlockPointer,
            offset: 0,
            why: 'prev->next = new',
        },
        { kind: 'label', name: 'set_up_new_space', why: '' },
        {
            kind: 'storeMemory',
            from: knownRegisters.argument1,
            address: knownRegisters.syscallResult,
            offset: 0,
            why: 'new->size = requested_size',
        },
        {
            kind: 'storeZeroToMemory',
            address: knownRegisters.syscallResult,
            offset: 1 * bytesInWord,
            why: 'new->next = null',
        },
        {
            kind: 'storeZeroToMemory',
            address: knownRegisters.syscallResult,
            offset: 2 * bytesInWord,
            why: 'new->free = false',
        },
        {
            kind: 'move',
            to: knownRegisters.functionResult,
            from: knownRegisters.syscallResult,
            why: 'Return result of sbrk',
        },
        {
            kind: 'addImmediate',
            register: knownRegisters.functionResult,
            amount: 3 * bytesInWord,
            why: 'Adjust result pointer to point to actuall space, not management block',
        },
        { kind: 'label', name: 'my_malloc_return', why: 'Done' },
        ...registerRestorer(3),
        { kind: 'returnToCaller', why: 'Done' },
    ];
};

export const length: RuntimeFunctionGenerator = (
    bytesInWord,
    syscallNumbers,
    registerSaver,
    registerRestorer,
    knownRegisters,
    firstRegister,
    nextRegister
): RegisterTransferLanguageExpression[] => {
    const currentChar = firstRegister;
    if (currentChar.type == 'memory') throw debug('Need a register');
    return [
        { kind: 'functionLabel', name: 'length', why: 'Length runtime function' },
        ...registerSaver(1),
        {
            kind: 'loadImmediate',
            destination: knownRegisters.functionResult,
            value: 0,
            why: 'Set length count to 0',
        },
        { kind: 'label', name: 'length_loop', why: 'Count another charachter' },
        {
            kind: 'loadMemoryByte',
            address: knownRegisters.argument1,
            to: currentChar,
            why: 'Load char into memory',
        },
        {
            kind: 'gotoIfZero',
            register: currentChar,
            label: 'length_return',
            why: 'If char is null, end of string. Return count.',
        },
        { kind: 'increment', register: knownRegisters.functionResult, why: 'Bump string index' },
        { kind: 'increment', register: knownRegisters.argument1, why: 'Bump length counter' },
        { kind: 'goto', label: 'length_loop', why: 'Go count another char' },
        { kind: 'label', name: 'length_return', why: 'Done' },
        ...registerRestorer(1),
        { kind: 'returnToCaller', why: 'Done' },
    ];
};

export const stringCopy: RuntimeFunctionGenerator = (
    bytesInWord,
    syscallNumbers,
    registerSaver,
    registerRestorer,
    knownRegisters,
    firstRegister,
    nextRegister
): RegisterTransferLanguageExpression[] => {
    const currentChar = firstRegister;
    if (currentChar.type == 'memory') throw debug('Need a register');
    return [
        { kind: 'functionLabel', name: 'string_copy', why: 'string_copy' },
        ...registerSaver(1),
        { kind: 'label', name: 'string_copy_loop', why: 'Copy a byte' },
        {
            kind: 'loadMemoryByte',
            to: currentChar,
            address: knownRegisters.argument1,
            why: 'Load byte from input',
        },
        {
            kind: 'storeMemoryByte',
            contents: currentChar,
            address: knownRegisters.argument2,
            why: 'Write it to output',
        },
        {
            kind: 'gotoIfZero',
            register: currentChar,
            label: 'string_copy_return',
            why: 'If char was the null terminator, return',
        },
        { kind: 'increment', register: knownRegisters.argument1, why: 'Bump pointers to next char' },
        { kind: 'increment', register: knownRegisters.argument2, why: 'Bump pointers to next char' },
        { kind: 'goto', label: 'string_copy_loop', why: 'Copy next char' },
        { kind: 'label', name: 'string_copy_return', why: '' },
        ...registerRestorer(1),
        { kind: 'returnToCaller', why: 'Done' },
    ];
};
