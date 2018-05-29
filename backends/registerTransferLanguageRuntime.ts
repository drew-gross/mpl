import { errors } from '../runtime-strings.js';
import debug from '../util/debug.js';
import { StorageSpec, saveRegistersCode, restoreRegistersCode } from '../backend-utils.js';
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
    knownRegisters: KnownRegisters,
    firstRegister: StorageSpec,
    nextRegister: ((r: StorageSpec) => StorageSpec),
    preamble: RegisterTransferLanguageExpression[],
    epilogue: RegisterTransferLanguageExpression[]
) => RegisterTransferLanguageExpression[];

const saveSyscallArgRegisters = knownRegisters =>
    [
        knownRegisters.syscallArg1,
        knownRegisters.syscallArg2,
        knownRegisters.syscallArg3,
        knownRegisters.syscallArg4,
        knownRegisters.syscallArg5,
        knownRegisters.syscallArg6,
    ].map((register: StorageSpec) => ({
        kind: 'push' as 'push',
        register: register,
        why: 'Save registers before using them as syscall args',
    }));

const restoreSyscallArgRegisters = knownRegisters =>
    [
        knownRegisters.syscallArg6,
        knownRegisters.syscallArg5,
        knownRegisters.syscallArg4,
        knownRegisters.syscallArg3,
        knownRegisters.syscallArg2,
        knownRegisters.syscallArg1,
    ].map((register: StorageSpec) => ({
        kind: 'pop' as 'pop',
        register: register,
        why: 'Restore registers after using them as syscall args',
    }));

const switchableMallocImpl = (
    bytesInWord,
    syscallNumbers,
    knownRegisters,
    firstRegister,
    nextRegister,
    preamble,
    epilogue,
    include: 'include curr = *curr' | 'dont include curr = *curr',
    makeSyscall
): RegisterTransferLanguageExpression[] => {
    const currentBlockPointer = firstRegister;
    const previousBlockPointer = nextRegister(currentBlockPointer);
    const scratch = nextRegister(previousBlockPointer);
    if (currentBlockPointer.type == 'memory') throw debug('need a register');
    if (previousBlockPointer.type == 'memory') throw debug('need a register');
    if (scratch.type == 'memory') throw debug('need a register');
    return [
        { kind: 'functionLabel', name: 'my_malloc', why: 'my_malloc' },
        ...preamble,
        ...saveRegistersCode(firstRegister, nextRegister, 3),
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
            to: scratch,
            why: 'Error to print',
        },
        {
            kind: 'syscall',
            name: 'print',
            arguments: [scratch],
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
            kind: 'addImmediate',
            amount: 3 * bytesInWord,
            register: knownRegisters.argument1,
            why: 'Add space for management block',
        },
        makeSyscall(knownRegisters.argument1, knownRegisters.functionResult),
        {
            kind: 'addImmediate',
            register: knownRegisters.argument1,
            amount: -3 * bytesInWord,
            why: 'Repair arg 1 after adding management block length to it',
        },
        {
            kind: 'gotoIfNotEqual',
            lhs: knownRegisters.functionResult,
            rhs: { type: 'register', destination: '-1' }, // TODO: should be immediate
            label: 'alloc_exit_check_passed',
            why: 'If mmap failed, exit',
        },
        {
            kind: 'loadSymbolAddress',
            to: scratch,
            symbolName: errors.allocationFailed.name,
            why: 'Load string to print',
        },
        {
            kind: 'syscall',
            name: 'print',
            arguments: [scratch],
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
            why: `${knownRegisters.functionResult} now contains pointer to block. Set up pointer to new block.`,
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
            from: knownRegisters.functionResult,
            to: { type: 'register', destination: 'first_block' },
            why: 'Setup first block pointer',
        },
        { kind: 'goto', label: 'set_up_new_space', why: '' },
        { kind: 'label', name: 'assign_previous', why: 'Set up prevous block pointer' },
        { kind: 'gotoIfZero', register: previousBlockPointer, label: 'set_up_new_space', why: '' },
        {
            kind: 'storeMemory',
            from: knownRegisters.functionResult,
            address: previousBlockPointer,
            offset: 0,
            why: 'prev->next = new',
        },
        { kind: 'label', name: 'set_up_new_space', why: '' },
        {
            kind: 'storeMemory',
            from: knownRegisters.argument1,
            address: knownRegisters.functionResult,
            offset: 0,
            why: 'new->size = requested_size',
        },
        {
            kind: 'storeZeroToMemory',
            address: knownRegisters.functionResult,
            offset: 1 * bytesInWord,
            why: 'new->next = null',
        },
        {
            kind: 'storeZeroToMemory',
            address: knownRegisters.functionResult,
            offset: 2 * bytesInWord,
            why: 'new->free = false',
        },
        {
            kind: 'addImmediate',
            register: knownRegisters.functionResult,
            amount: 3 * bytesInWord,
            why: 'Adjust result pointer to point to actuall space, not management block',
        },
        { kind: 'label', name: 'my_malloc_return', why: 'Done' },
        ...restoreRegistersCode(firstRegister, nextRegister, 3),
        ...epilogue,
        { kind: 'returnToCaller', why: 'Done' },
    ];
};

export const mallocWithSbrk: RuntimeFunctionGenerator = (
    bytesInWord,
    syscallNumbers,
    knownRegisters,
    firstRegister,
    nextRegister,
    preamble,
    epilogue
): RegisterTransferLanguageExpression[] => {
    return switchableMallocImpl(
        bytesInWord,
        syscallNumbers,
        knownRegisters,
        firstRegister,
        nextRegister,
        preamble,
        epilogue,
        'dont include curr = *curr',
        (amount, destination) => ({
            kind: 'syscall',
            name: 'sbrk',
            arguments: [amount],
            why: 'sbrk',
            destination: destination,
        })
    );
};

export const mallocWithMmap: RuntimeFunctionGenerator = (
    bytesInWord,
    syscallNumbers,
    knownRegisters,
    firstRegister,
    nextRegister,
    preamble,
    epilogue
): RegisterTransferLanguageExpression[] => {
    return switchableMallocImpl(
        bytesInWord,
        syscallNumbers,
        knownRegisters,
        firstRegister,
        nextRegister,
        preamble,
        epilogue,
        'include curr = *curr',
        (amount, destination) => ({
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
        })
    );
};

export const length: RuntimeFunctionGenerator = (
    bytesInWord,
    syscallNumbers,
    knownRegisters,
    firstRegister,
    nextRegister,
    preamble,
    epilogue
): RegisterTransferLanguageExpression[] => {
    const currentChar = firstRegister;
    if (currentChar.type == 'memory') throw debug('Need a register');
    return [
        { kind: 'functionLabel', name: 'length', why: 'Length runtime function' },
        ...preamble,
        ...saveRegistersCode(firstRegister, nextRegister, 1),
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
        {
            kind: 'subtract',
            lhs: knownRegisters.argument1,
            rhs: knownRegisters.functionResult,
            destination: knownRegisters.argument1,
            why: 'Repair pointer passed in arg1 so caller can still use it',
        },
        ...restoreRegistersCode(firstRegister, nextRegister, 1),
        ...epilogue,
        { kind: 'returnToCaller', why: 'Done' },
    ];
};

export const stringCopy: RuntimeFunctionGenerator = (
    bytesInWord,
    syscallNumbers,
    knownRegisters,
    firstRegister,
    nextRegister,
    preamble,
    epilogue
): RegisterTransferLanguageExpression[] => {
    const currentChar = firstRegister;
    if (currentChar.type == 'memory') throw debug('Need a register');
    return [
        { kind: 'functionLabel', name: 'string_copy', why: 'string_copy' },
        ...preamble,
        ...saveRegistersCode(firstRegister, nextRegister, 1),
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
        ...restoreRegistersCode(firstRegister, nextRegister, 1),
        ...epilogue,
        { kind: 'returnToCaller', why: 'Done' },
    ];
};

export const printWithPrintRuntimeFunction: RuntimeFunctionGenerator = (
    bytesInWord,
    syscallNumbers,
    knownRegisters,
    firstRegister,
    nextRegister,
    preamble,
    epilogue
): RegisterTransferLanguageExpression[] => {
    return [
        { kind: 'functionLabel', name: 'print', why: 'Print: string->' },
        {
            kind: 'syscall',
            name: 'print',
            arguments: [knownRegisters.argument1],
            why: 'Print',
            destination: knownRegisters.functionResult,
        },
        { kind: 'returnToCaller', why: 'Return' },
    ];
};

export const printWithWriteRuntimeFunction: RuntimeFunctionGenerator = (
    bytesInWord,
    syscallNumbers,
    knownRegisters,
    firstRegister,
    nextRegister,
    preamble,
    epilogue
): RegisterTransferLanguageExpression[] => {
    return [
        { kind: 'functionLabel', name: 'print', why: 'Print: string->' },
        {
            kind: 'call',
            function: 'length',
            why: 'Call length on argument so we can pass it to write(2). (Arugment is already in argument register)',
        },
        {
            kind: 'syscall',
            name: 'print',
            arguments: [
                1, // Load stdout fd into argument 1 of write(2) (stdout fd is 1)
                knownRegisters.argument1, // Put string ptr in arg 2 of write(2)
                knownRegisters.functionResult, // 3rd argument to write(2) is length
            ],
            why: 'Print',
            destination: knownRegisters.functionResult,
        },
        { kind: 'returnToCaller', why: 'Return' },
    ];
};

// TODO: figure out a way to verify that this is working
export const verifyNoLeaks: RuntimeFunctionGenerator = (
    bytesInWord,
    syscallNumbers,
    knownRegisters,
    firstRegister,
    nextRegister,
    preamble,
    epilogue
): RegisterTransferLanguageExpression[] => {
    const currentBlockPointer = firstRegister;
    const currentData = nextRegister(currentBlockPointer);
    return [
        { kind: 'functionLabel', name: 'verify_no_leaks', why: 'verify_no_leaks' },
        ...preamble,
        ...saveRegistersCode(firstRegister, nextRegister, 2),
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
            kind: 'gotoIfNotEqual',
            lhs: currentData,
            rhs: { type: 'register', destination: '0' },
            label: 'verify_no_leaks_advance_pointers',
            why: "Don't error if free",
        },
        {
            kind: 'loadSymbolAddress',
            to: currentData,
            symbolName: errors.leaksDetected.name,
            why: 'Error to print',
        },
        {
            kind: 'syscall',
            name: 'print',
            arguments: [currentData],
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
        ...restoreRegistersCode(firstRegister, nextRegister, 2),
        ...epilogue,
        { kind: 'returnToCaller', why: 'Done' },
    ];
};

export const stringConcatenateRuntimeFunction: RuntimeFunctionGenerator = (
    bytesInWord,
    syscallNumbers,
    knownRegisters,
    firstRegister,
    nextRegister,
    preamble,
    epilogue
): RegisterTransferLanguageExpression[] => {
    const left = knownRegisters.argument1;
    const right = knownRegisters.argument2;
    const out = knownRegisters.argument3;
    const currentChar = firstRegister;
    return [
        { kind: 'functionLabel', name: 'string_concatenate', why: 'string_concatenate' },
        ...preamble,
        ...saveRegistersCode(firstRegister, nextRegister, 1),
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
        ...restoreRegistersCode(firstRegister, nextRegister, 1),
        ...epilogue,
        { kind: 'returnToCaller', why: 'Return' },
    ];
};

export const stringEqualityRuntimeFunction: RuntimeFunctionGenerator = (
    bytesInWord,
    syscallNumbers,
    knownRegisters,
    firstRegister,
    nextRegister,
    preamble,
    epilogue
) => {
    const leftByte: StorageSpec = firstRegister;
    const rightByte: StorageSpec = nextRegister(firstRegister);
    return [
        { kind: 'functionLabel', name: 'stringEquality', why: 'stringEquality' },
        ...preamble,
        ...saveRegistersCode(firstRegister, nextRegister, 2),
        {
            kind: 'loadImmediate',
            destination: knownRegisters.functionResult,
            value: 1,
            why: `Assume equal. Write true to ${
                knownRegisters.functionResult.destination
            }. Overwrite if difference found.`,
        },
        { kind: 'label', name: 'stringEquality_loop', why: 'Check a char, (string*, string*) -> bool' },
        {
            kind: 'loadMemoryByte',
            to: leftByte,
            address: knownRegisters.argument1,
            why: 'Load current left char into temporary',
        },
        {
            kind: 'loadMemoryByte',
            to: rightByte,
            address: knownRegisters.argument2,
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
        { kind: 'increment', register: knownRegisters.argument1, why: 'Bump lhs to next char' },
        { kind: 'increment', register: knownRegisters.argument2, why: 'Bump rhs to next char' },
        { kind: 'goto', label: 'stringEquality_loop', why: 'Check next char' },
        { kind: 'label', name: 'stringEquality_return_false', why: 'stringEquality_return_false' },
        { kind: 'loadImmediate', destination: knownRegisters.functionResult, value: 0, why: 'Set result to false' },
        { kind: 'label', name: 'stringEquality_return', why: '' },
        ...restoreRegistersCode(firstRegister, nextRegister, 2),
        ...epilogue,
        { kind: 'returnToCaller', why: 'Return' },
    ];
};

export const myFreeRuntimeFunction = (
    bytesInWord,
    syscallNumbers,
    knownRegisters,
    firstRegister,
    nextRegister,
    preamble,
    epilogue
): RegisterTransferLanguageExpression[] => {
    const one: StorageSpec = firstRegister;
    return [
        { kind: 'functionLabel', name: 'my_free', why: 'my_free' },
        ...preamble,
        ...saveRegistersCode(firstRegister, nextRegister, 1),
        {
            kind: 'gotoIfNotEqual',
            lhs: knownRegisters.argument1,
            rhs: { type: 'register', destination: '0' },
            label: 'free_null_check_passed',
            why: 'Not freeing null check passed',
        },
        {
            kind: 'loadSymbolAddress',
            to: one,
            symbolName: errors.freeNull.name,
            why: 'Error to print',
        },
        {
            kind: 'syscall',
            name: 'print',
            arguments: [one],
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
            kind: 'storeMemory',
            from: one,
            address: knownRegisters.argument1,
            offset: -1 * bytesInWord,
            why: 'block->free = false',
        },
        ...restoreRegistersCode(firstRegister, nextRegister, 1),
        ...epilogue,
        { kind: 'returnToCaller', why: 'Return' },
    ];
};
