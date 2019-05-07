import { errors } from '../runtime-strings.js';
import debug from '../util/debug.js';
import { Register, toString as s } from '../register.js';
import { ThreeAddressFunction } from './generator.js';
import { programToString, functionToString } from './programToString.js';
import { parseProgram as parseTac, parseFunctionOrDie, parseInstructionsOrDie as ins } from './parser.js';

export type RuntimeFunctionGenerator = (bytesInWord: number) => ThreeAddressFunction;

const switchableMallocImpl = (
    bytesInWord,
    include: 'include curr = *curr' | 'dont include curr = *curr',
    makeSyscall
): ThreeAddressFunction => {
    const currentBlockPointer = { name: 'currentBlockPointer' };
    const previousBlockPointer = { name: 'previousBlockPointer' };
    const currentBlockIsFree = { name: 'currentBlockIsFree' };
    const currentBlockSize = { name: 'currentBlockSize' };
    const zero = { name: 'zero' };
    const err = { name: 'err' };
    return {
        name: 'my_malloc',
        spills: 0,
        instructions: [
            ...ins(`
                ${s(zero)} = 0;
                goto my_malloc_zero_size_check_passed if $arg1 > ${s(zero)};
                ; Error if zero bytes requested
                ${s(err)} = &${errors.allocatedZero.name};
                syscall print ${s(err)}; TODO probably need to use a function since syscall isn't portable
                syscall exit -1;
            my_malloc_zero_size_check_passed:;
                ${s(currentBlockPointer)} = &first_block;
            `),
            // TODO: something weird is going on here. For some reason, x64 backend requires this line, and mips doesn't. Figure out what is right.
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
            ...ins(`
                ${s(previousBlockPointer)} = 0;
            find_large_enough_free_block_loop:;
                goto found_large_enough_block if ${s(currentBlockPointer)} == 0; No blocks left, need syscall
                ${s(currentBlockIsFree)} = *(${s(currentBlockPointer)} + ${2 * bytesInWord});
                goto advance_pointers if ${s(currentBlockIsFree)} == 0; Current block not free
                ${s(currentBlockSize)} = *(${s(currentBlockPointer)} + 0);
                goto advance_pointers if $arg1 > ${s(currentBlockSize)}; Current block too small
                goto found_large_enough_block;
            advance_pointers:;
                ${s(previousBlockPointer)} = ${s(currentBlockPointer)};
                ${s(currentBlockPointer)} = *(${s(currentBlockPointer)} + ${1 * bytesInWord});
                goto find_large_enough_free_block_loop; Try the next block
            found_large_enough_block:;
                goto sbrk_more_space if ${s(currentBlockPointer)} == 0; JK need to syscall lol
                *(${s(currentBlockPointer)} + ${2 * bytesInWord}) = 0; block->free = false
                $result = ${s(currentBlockPointer)};
                $result += ${3 * bytesInWord}; Adjust ptr to point to actual space, not control block
                goto my_malloc_return;
            sbrk_more_space:;
                $arg1 += ${3 * bytesInWord}; sbrk enough space for management block too
            `),
            makeSyscall('arg1', 'result'),
            {
                kind: 'addImmediate',
                register: 'arg1',
                amount: -3 * bytesInWord,
                why: 'Repair arg 1 after adding management block length to it',
            },
            {
                kind: 'gotoIfNotEqual',
                lhs: 'result',
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
                why: 'result now contains pointer to block. Set up pointer to new block.',
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
                from: 'result',
                to: 'first_block',
                why: 'Setup first block pointer',
            },
            { kind: 'goto', label: 'set_up_new_space', why: '' },
            { kind: 'label', name: 'assign_previous', why: 'Set up prevous block pointer' },
            { kind: 'gotoIfZero', register: previousBlockPointer, label: 'set_up_new_space', why: '' },
            {
                kind: 'storeMemory',
                from: 'result',
                address: previousBlockPointer,
                offset: 0,
                why: 'prev->next = new',
            },
            { kind: 'label', name: 'set_up_new_space', why: '' },
            {
                kind: 'storeMemory',
                from: 'arg1',
                address: 'result',
                offset: 0,
                why: 'new->size = requested_size',
            },
            {
                kind: 'storeZeroToMemory',
                address: 'result',
                offset: 1 * bytesInWord,
                why: 'new->next = null',
            },
            {
                kind: 'storeZeroToMemory',
                address: 'result',
                offset: 2 * bytesInWord,
                why: 'new->free = false',
            },
            {
                kind: 'addImmediate',
                register: 'result',
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
    parseFunctionOrDie(`
    (function) length:
            $result = 0;
        length_loop:; Count another charachter
            r:currentChar = *$arg1; Load next byte
            goto length_return if r:currentChar == 0; If it's null, we are done
            $result++; Bump string index
            $arg1++; Bump length counter
            goto length_loop; Go count another char
        length_return:; Done
            $arg1 = $arg1 - $result; Repair input pointer
    `);

export const stringCopy: RuntimeFunctionGenerator = bytesInWord =>
    parseFunctionOrDie(`
    (function) string_copy:; Copy string pointer to by first argument to second argument
        string_copy_loop:; Copy a byte
            r:currentChar = *$arg1; Load next char from string
            *$arg2 = r:currentChar; Write char to output
            goto string_copy_return if r:currentChar == 0; If at end, return
            $arg1++; Else increment to next char
            $arg2++; Increment output too
            goto string_copy_loop; and go keep copying
        string_copy_return:; Done
    `);

export const printWithPrintRuntimeFunction: RuntimeFunctionGenerator = bytesInWord =>
    parseFunctionOrDie(`
    (function) print:
        syscalld print $result $arg1; Print the thing
    `);

export const printWithWriteRuntimeFunction: RuntimeFunctionGenerator = bytesInWord =>
    parseFunctionOrDie(`
    (function) print:
        length(); Call length on argument (Arugment is already in argument register)
        syscalld print $result 1 $arg1 $result; 1: fd of stdout. $arg1: ptr to data to write. $result: length to write
   `);

export const readIntDirect: RuntimeFunctionGenerator = bytesInWord =>
    parseFunctionOrDie(`
        (function) readInt:
              syscalld readInt $result; make syscall
    `);

export const readIntThroughSyscall: RuntimeFunctionGenerator = bytesInWord => {
    const stdinFd = 0;
    const bufferSize = 10;
    return parseFunctionOrDie(`
        (function) readInt:
            $arg1 = ${bufferSize}; 10 byte buffer because why not TODO
            my_malloc(); malloc
            r:buffer = $result; rename
            syscalld read r:readResult ${stdinFd} r:buffer ${bufferSize}; syscall
            r:negativeOne = -1; goto does not support literals
            goto read_failed if r:readResult == r:negativeOne; syscall failed
            $arg1 = r:buffer; prep to parse int
            intFromString(); parse int and return
            my_free(); Free the buffer
            goto readIntExit; result already in result
        read_failed:; label
            r:err = &${errors.readIntFailed.name}; Error to print
            syscall print r:err; syscall
            syscall exit -1; syscall
        readIntExit:; exit
    `);
};

// TODO: figure out a way to verify that this is working
export const verifyNoLeaks: RuntimeFunctionGenerator = bytesInWord =>
    parseFunctionOrDie(`
    (function) verify_no_leaks:
        r:currentBlockPointer = &first_block; Load first block address
        r:currentBlockPointer = *(r:currentBlockPointer + ${0 * bytesInWord}); Load first block pointer
    verify_no_leaks_loop:; verify_no_leaks_loop
        goto verify_no_leaks_return if r:currentBlockPointer == 0; Last block, can return now
        r:currentData = *(r:currentBlockPointer + ${2 * bytesInWord}); data = block->free
        r:one = 1; Need for comparison
        goto verify_no_leaks_advance_pointers if r:currentData == r:one; Don't error if free
        r:err = &${errors.leaksDetected.name}; Error to print
        syscall print r:err; syscall
        syscall exit -1; syscall
    verify_no_leaks_advance_pointers:; verify_no_leaks_advance_pointers
        r:currentBlockPointer = *(r:currentBlockPointer + ${1 * bytesInWord}); block = block->next
        goto verify_no_leaks_loop; Check next block
    verify_no_leaks_return:; All done
    `);

export const stringConcatenateRuntimeFunction: RuntimeFunctionGenerator = bytesInWord =>
    parseFunctionOrDie(`
    (function) string_concatenate:
        write_left_loop:; Append left string
            r:currentChar = *$arg1; Load byte from left
            goto copy_from_right if r:currentChar == 0; If end of left, start copying right
            *$arg3 = r:currentChar; Write byte from left
            $arg1++; Bump left pointer
            $arg3++; Bump out pointer
            goto write_left_loop; Loop to next char
        copy_from_right:; Append right string
            r:currentChar = *$arg2; Load byte from right
            *$arg3 = r:currentChar; Copy right byte (incl. null)
            goto concatenate_return if r:currentChar == 0; If we just wrote null, we are done
            $arg2++; Bump right pointer
            $arg3++; Bump out pointer
            goto copy_from_right; Go copy next char
        concatenate_return:; Exit. TODO: repair input pointers?
    `);

export const stringEqualityRuntimeFunction: RuntimeFunctionGenerator = bytesInWord =>
    parseFunctionOrDie(`
    (function) stringEquality:
            $result = 1; Result = true (willl write false if diff found)
        stringEquality_loop:; Check a char
            r:leftByte = *$arg1; Load left char into temporary
            r:rightByte = *$arg2; Load right char into temporary
            goto stringEquality_return_false if r:leftByte != r:rightByte; Inequal: return false
            goto stringEquality_return if r:leftByte == 0; Both side are equal. If both sides are null, return.
            $arg1++; Bump lhs to next char
            $arg2++; Bump rhs to next char
            goto stringEquality_loop; Check next char
        stringEquality_return_false:; stringEquality_return_false
            $result = 0; Set result to false
        stringEquality_return:; Exit
    `);

// TODO: merge adjacent free blocks
// TOOD: check if already free
export const myFreeRuntimeFunction: RuntimeFunctionGenerator = bytesInWord =>
    parseFunctionOrDie(`
    (function) my_free:
            r:zero = 0; Need a zero
            goto free_null_check_passed if $arg1 != r:zero; Not freeing null check passed
            r:err = &${errors.freeNull.name}; Error to print
            syscall print r:err; Print
            syscall exit -1; Exit
        free_null_check_passed:; Not attempting to free null
            r:one = 1; Need a 1
            r:managementBlockSize = ${3 * bytesInWord}; 3 words for management
            $arg1 = $arg1 - r:managementBlockSize; Get management block ptr
            *($arg1 + ${2 * bytesInWord}) = r:one; block->free = true
    `);

// TODO: return error if string doesn't contain an int
export const intFromString: RuntimeFunctionGenerator = bytesInWord => {
    return parseFunctionOrDie(`
    (function) intFromString:
        $result = 0; Accumulate into here
        r:input = $arg1; Make a copy so we can modify it
    add_char:; comment
        r:currentChar = *r:input; load a char
        goto exit if r:currentChar == 0; Found the null terminator; done
        r:fortyEight = 48; forty eight
        r:currentNum = r:currentChar - r:fortyEight; Subtract '0' to get actual number
        r:ten = 10; ten
        $result = $result * r:ten; Previous digit was 10x
        $result = $result + r:currentNum; Add the num
        r:input++; Get next char in next loop iteration
        goto add_char; comment
    exit:; comment
    `);
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
    readIntDirect,
];
