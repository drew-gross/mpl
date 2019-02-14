import { errors } from '../runtime-strings.js';
import debug from '../util/debug.js';
import { Register } from '../register.js';
import { ThreeAddressFunction } from './generator.js';
import { programToString, functionToString } from './programToString.js';
import { parseProgram as parseTac, parseFunction } from './parser.js';
import prettyParseError from '../parser-lib/pretty-parse-error.js';

export type RuntimeFunctionGenerator = (bytesInWord: number) => ThreeAddressFunction;

const parseFunctionOrDie = (tacString: string): ThreeAddressFunction => {
    const parsed = parseFunction(tacString);
    if ('kind' in parsed) {
        throw debug('error');
    }
    if (Array.isArray(parsed)) {
        throw debug('error');
    }
    return parsed;
};

const switchableMallocImpl = (
    bytesInWord,
    include: 'include curr = *curr' | 'dont include curr = *curr',
    makeSyscall
): ThreeAddressFunction => {
    const currentBlockPointer = { name: 'currentBlockPointer' };
    const previousBlockPointer = { name: 'previousBlockPointer' };
    const currentBlockIsFree = { name: 'current_block_is_free' };
    const zero = { name: 'zero' };
    const err = { name: 'err' };
    return {
        name: 'my_malloc',
        spills: 0,
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
        destination,
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
        destination,
    }));
};

export const length: RuntimeFunctionGenerator = bytesInWord =>
    parseFunction(`
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
    `) as ThreeAddressFunction;

export const stringCopy: RuntimeFunctionGenerator = bytesInWord =>
    parseFunctionOrDie(`
    (function) string_copy: # Copy string pointer to by first argument to second argument
        string_copy_loop: # Copy a byte
            r:currentChar = *r:functionArgument1 # Load next char from string
            *r:functionArgument2 = r:currentChar # Write char to output
            goto string_copy_return if r:currentChar == 0 # If at end, return
            r:functionArgument1++ # Else increment to next char
            r:functionArgument2++ # Increment output too
            goto string_copy_loop # and go keep copying
        string_copy_return: # Done
    `);

export const printWithPrintRuntimeFunction: RuntimeFunctionGenerator = bytesInWord =>
    parseFunction(`
    (function) print:
        syscalld print r:functionResult r:functionArgument1 # Print the thing
    `) as ThreeAddressFunction;

export const printWithWriteRuntimeFunction: RuntimeFunctionGenerator = bytesInWord => {
    return {
        name: 'print',
        spills: 0,
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

export const readIntDirect: RuntimeFunctionGenerator = bytesInWord => {
    const result = parseFunction(`
        (function) readInt:
              syscalld readInt r:functionResult # make syscall
    `);
    if (Array.isArray(result)) {
        throw debug('was array');
    } else if ('kind' in result) {
        throw debug('was lex error');
    }
    return result;
};

export const readIntThroughSyscall: RuntimeFunctionGenerator = bytesInWord => {
    const stdinFd = 0;
    const bufferSize = 10;
    return parseFunctionOrDie(`
        (function) readInt:
            r:functionArgument1 = ${bufferSize} # 10 byte buffer because why not TODO
            my_malloc() # malloc
            r:buffer = r:functionResult # rename
            syscalld read r:readResult ${stdinFd} ${bufferSize} # syscall
            r:negativeOne = -1 # goto doesn not support literals
            goto read_failed if r:readResult == r:negativeOne # syscall failed
            r:functionArgument1 = r:buffer # prep to parse int
            intFromString() # parse int and return
        read_failed: # label
            r:err = &${errors.readIntFailed.name} # Error to print
            syscall print r:err # syscall
            syscall exit -1 # syscall
    `);
};

// TODO: figure out a way to verify that this is working
export const verifyNoLeaks: RuntimeFunctionGenerator = bytesInWord =>
    parseFunction(`
    (function) verify_no_leaks:
        r:currentBlockPointer = &first_block # Load first block address
        r:currentBlockPointer = *(r:currentBlockPointer + ${0 * bytesInWord}) # Load first block pointer
    verify_no_leaks_loop: # verify_no_leaks_loop
        goto verify_no_leaks_return if r:currentBlockPointer == 0 # Last block, can return now
        r:currentData = *(r:currentBlockPointer + ${2 * bytesInWord}) # data = block->free
        r:one = 1 # Need for comparison
        goto verify_no_leaks_advance_pointers if r:currentData == r:one # Don't error if free
        r:err = &${errors.leaksDetected.name} # Error to print
        syscall print r:err # syscall
        syscall exit -1 # syscall
    verify_no_leaks_advance_pointers: # verify_no_leaks_advance_pointers
        r:currentBlockPointer = *(r:currentBlockPointer + ${1 * bytesInWord}) # block = block->next
        goto verify_no_leaks_loop # Check next block
    verify_no_leaks_return: # All done
    `) as ThreeAddressFunction;

export const stringConcatenateRuntimeFunction: RuntimeFunctionGenerator = bytesInWord =>
    parseFunction(`
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
    `) as ThreeAddressFunction;

export const stringEqualityRuntimeFunction: RuntimeFunctionGenerator = bytesInWord =>
    parseFunction(`
    (function) stringEquality:
            r:functionResult = 1 # Result = true (willl write false if diff found)
        stringEquality_loop: # Check a char
            r:leftByte = *r:functionArgument1 # Load left char into temporary
            r:rightByte = *r:functionArgument2 # Load right char into temporary
            goto stringEquality_return_false if r:leftByte != r:rightByte # Inequal: return false
            goto stringEquality_return if r:leftByte == 0 # Both side are equal. If both sides are null, return.
            r:functionArgument1++ # Bump lhs to next char
            r:functionArgument2++ # Bump rhs to next char
            goto stringEquality_loop # Check next char
        stringEquality_return_false: # stringEquality_return_false
            r:functionResult = 0 # Set result to false
        stringEquality_return: # Exit
    `) as ThreeAddressFunction;

// TODO: merge adjacent free blocks
// TOOD: check if already free
export const myFreeRuntimeFunction: RuntimeFunctionGenerator = bytesInWord =>
    parseFunction(`
    (function) my_free:
            r:zero = 0 # Need a zero
            goto free_null_check_passed if r:functionArgument1 != r:zero # Not freeing null check passed
            r:err = &${errors.freeNull.name} # Error to print
            syscall print r:err # Print
            syscall exit -1 # Exit
        free_null_check_passed: # Not attempting to free null
            r:one = 1 # Need a 1
            r:managementBlockSize = ${3 * bytesInWord} # 3 words for management
            r:functionArgument1 = r:functionArgument1 - r:managementBlockSize # Get management block ptr
            *(r:functionArgument1 + ${2 * bytesInWord}) = r:one # block->free = true
    `) as ThreeAddressFunction;

// TODO: return error if string doesn't contain an int
export const intFromString: RuntimeFunctionGenerator = bytesInWord =>
    parseFunction(`
    (function) intFromString:
        r:functionResult = 0 # Accumulate into here
        r:input = r:functionArgument1 # Make a copy so we can modify it
    add_char:
        r:currentChar = *r:input # load a char
        goto exit if r:currentChar == 0 # Found the null terminator; done
        r:currentNum = r:currentChar - 48 # Subtract '0' to get actual number
        r:functionResult = r:functionResult * 10 # Previous digit was 10x
        r:functionResult = r:functionResult + r:currentNum # Add the num
        r:input++ # Get next char in next loop iteration
        goto add_char
    exit:
    `) as ThreeAddressFunction;

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
    readIntDirect,
];
