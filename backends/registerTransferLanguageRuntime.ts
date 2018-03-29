import { errors } from '../runtime-strings.js';
import debug from '../util/debug.js';
import { StorageSpec } from '../backend-utils.js';
import { RegisterTransferLanguageExpression } from './registerTransferLanguage.js';

export const malloc = (
    bytesInWord,
    syscallNumbers,
    registerSaver,
    registerRestorer,
    knownRegisters,
    firstRegister: StorageSpec,
    nextRegister: ((r: StorageSpec) => StorageSpec)
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
            rhs: '0',
            label: 'my_malloc_zero_size_check_passed',
            why: 'Error if no memory requested',
        },
        {
            kind: 'loadSymbolAddress',
            symbolName: errors.allocatedZero.name,
            to: { type: 'register', destination: knownRegisters.syscallArg1 },
            why: 'Error to print',
        },
        {
            kind: 'loadImmediate',
            destination: { type: 'register', destination: knownRegisters.syscallSelect },
            value: syscallNumbers.print,
            why: 'Select print syscall',
        },
        { kind: 'syscall', why: 'Print' },
        {
            kind: 'loadImmediate',
            destination: { type: 'register', destination: knownRegisters.syscallSelect },
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
            register: currentBlockPointer.destination,
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
        { kind: 'gotoIfZero', register: scratch.destination, label: 'advance_pointers', why: 'Check next block' },
        {
            kind: 'loadMemory',
            to: scratch,
            from: currentBlockPointer,
            offset: 0,
            why: 'Current block not large enough, try next',
        },
        {
            kind: 'gotoIfGreater',
            lhs: scratch.destination,
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
            to: previousBlockPointer.destination,
            from: currentBlockPointer.destination,
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
            register: currentBlockPointer.destination,
            label: 'sbrk_more_space',
            why: 'No good blocks, so make one',
        },
        {
            kind: 'storeMemory',
            from: '$0',
            address: currentBlockPointer.destination,
            offset: 2 * bytesInWord,
            why: 'Found a reusable block, mark it as not free',
        },
        {
            kind: 'move',
            to: knownRegisters.functionResult,
            from: currentBlockPointer.destination,
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
            destination: { type: 'register', destination: knownRegisters.syscallSelect },
            value: syscallNumbers.sbrk,
            why: 'Select sbrk syscall',
        },
        { kind: 'syscall', why: 'sbrk' },
        {
            kind: 'gotoIfNotEqual',
            lhs: knownRegisters.syscallResult,
            rhs: '-1',
            label: 'sbrk_exit_check_passed',
            why: 'If sbrk failed, exit',
        },
        {
            kind: 'loadSymbolAddress',
            to: { type: 'register', destination: knownRegisters.syscallArg1 },
            symbolName: errors.allocationFailed.name,
            why: 'Load string to print',
        },
        {
            kind: 'loadImmediate',
            destination: { type: 'register', destination: knownRegisters.syscallSelect },
            value: syscallNumbers.print,
            why: 'Prepare to print',
        },
        { kind: 'syscall', why: 'Print' },
        {
            kind: 'loadImmediate',
            destination: { type: 'register', destination: knownRegisters.syscallSelect },
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
            lhs: scratch.destination,
            rhs: '0',
            label: 'assign_previous',
            why: 'If there is no previous block, set up first block pointer',
        },
        {
            kind: 'storeGlobal',
            from: knownRegisters.syscallResult,
            to: 'first_block',
            why: 'Setup first block pointer',
        },
        { kind: 'goto', label: 'set_up_new_space', why: '' },
        { kind: 'label', name: 'assign_previous', why: 'Set up prevous block pointer' },
        { kind: 'gotoIfZero', register: previousBlockPointer.destination, label: 'set_up_new_space', why: '' },
        {
            kind: 'storeMemory',
            from: knownRegisters.syscallResult,
            address: previousBlockPointer.destination,
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
            kind: 'storeMemory',
            from: '$0',
            address: knownRegisters.syscallResult,
            offset: 1 * bytesInWord,
            why: 'new->next = null',
        },
        {
            kind: 'storeMemory',
            from: '$0',
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
