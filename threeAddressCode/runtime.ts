import { errors } from '../runtime-strings';
import { Function } from './Function';
import { parseInstructionsOrDie as ins } from './parser';
import { parseFunctionOrDie } from './Function';
import { Register } from './Register';

export type RuntimeFunctionGenerator = (bytesInWord: number) => Function;

const memoize = fn => {
    const cache = new Map();
    return arg => {
        if (cache.has(arg)) {
            return cache.get(arg);
        }
        const result = fn(arg);
        cache.set(arg, result);
        return result;
    }
}

const switchableMallocImpl = (bytesInWord, makeSyscall): Function => ({
    name: 'my_malloc',
    liveAtExit: [],
    arguments: [new Register('numBytes')],
    instructions: [
        ...ins(`
            r:zero = 0;
            goto my_malloc_zero_size_check_passed if r:numBytes > r:zero;
            ; Error if zero bytes requested
            r:err = &${errors.allocatedZero.name};
            syscall print r:err; TODO probably need to use a function since syscall isn't portable
            syscall exit -1;
        my_malloc_zero_size_check_passed:;
            r:currentBlockPointer = &first_block;
            r:currentBlockPointer = *(r:currentBlockPointer + 0); curr = *curr (TODO: why?)
            r:previousBlockPointer = 0;
        find_large_enough_free_block_loop:;
            goto found_large_enough_block if r:currentBlockPointer == 0; No blocks left, need syscall
            r:currentBlockIsFree = *(r:currentBlockPointer + ${2 * bytesInWord});
            goto advance_pointers if r:currentBlockIsFree == 0; Current block not free
            r:currentBlockSize = *(r:currentBlockPointer + 0);
            goto advance_pointers if r:numBytes > r:currentBlockSize; Current block too small
            goto found_large_enough_block;
        advance_pointers:;
            r:previousBlockPointer = r:currentBlockPointer;
            r:currentBlockPointer = *(r:currentBlockPointer + ${1 * bytesInWord});
            goto find_large_enough_free_block_loop; Try the next block
        found_large_enough_block:;
            goto sbrk_more_space if r:currentBlockPointer == 0; JK need to syscall lol
            *(r:currentBlockPointer + ${2 * bytesInWord}) = 0; block->free = false
            r:currentBlockPointer += ${3 * bytesInWord
            }; Adjust pointer to point to actual space, not control block
            goto my_malloc_return;
        sbrk_more_space:;
            r:numBytes += ${3 * bytesInWord}; sbrk enough space for management block too
        `),
        makeSyscall(new Register('numBytes'), new Register('currentBlockPointer')),
        ...ins(`
            r:numBytes += ${-3 * bytesInWord}; Repair arg1
            goto alloc_exit_check_passed if r:currentBlockPointer != -1;
            r:err = &${errors.allocationFailed.name};
            syscall print r:err;
            syscall exit -1;
        alloc_exit_check_passed:;
            ; if there are any existing blocks, set up this block
            r:firstBlockPointerAddress = &first_block;
            goto assign_previous if r:firstBlockPointerAddress != 0;
            ; if no existing blocks, mark this as the first block
            *first_block = r:currentBlockPointer;
            goto set_up_new_space;
        assign_previous:;
            goto set_up_new_space if r:previousBlockPointer == 0;
            *(r:previousBlockPointer + 0) = r:currentBlockPointer; prev->next = new
        set_up_new_space:;
            *(r:currentBlockPointer + 0) = r:numBytes; new->size = requested_size
            *(r:currentBlockPointer + ${1 * bytesInWord}) = 0; new->next = null
            *(r:currentBlockPointer + ${2 * bytesInWord}) = 0; new->free = false
            r:currentBlockPointer += ${3 * bytesInWord
            }; Adjust pointer to point to actual space, not control block
        my_malloc_return:;
            return r:currentBlockPointer;
        `),
    ],
});

export const mallocWithSbrk: RuntimeFunctionGenerator = memoize(bytesInWord =>
    switchableMallocImpl(bytesInWord, (amount, destination) => ({
        kind: 'syscall',
        name: 'sbrk',
        arguments: [amount],
        why: 'sbrk',
        destination,
    })));

export const mallocWithMmap: RuntimeFunctionGenerator = memoize(bytesInWord =>
    switchableMallocImpl(bytesInWord, (amount, destination) => ({
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
    })));

export const length: RuntimeFunctionGenerator = memoize(_bytesInWord =>
    parseFunctionOrDie(`
    (function) length(r:str):
            r:currentCharPtr = r:str; Make a copy of the arg that we can modify (TODO: disallow modifying arg)
            r:len = 0;
        length_loop:; Count another charachter
            r:currentChar = *r:currentCharPtr; Load next byte
            goto length_return if r:currentChar == 0; If it's null, we are done
            r:len++; Bump string index
            r:currentCharPtr++; Bump length counter
            goto length_loop; Go count another char
        length_return:; Done
            return r:len;
    `));

export const startsWith: RuntimeFunctionGenerator = memoize(_bytesInWord =>
    parseFunctionOrDie(`
    (function) startsWith(r:haystack, r:needle):
            r:haystackPtr = r:haystack;
            r:needlePtr = r:needle;
        compare_loop:; Count another charachter
            r:needleChar = *r:needlePtr; Load next needle byte
            goto true_return if r:needleChar == 0; If it's null, we are done
            r:haystackChar = *r:haystackPtr; Load next haystack byte
            goto false_return if r:haystackChar != r:needleChar; check equal
            r:haystackPtr++; Bump pointers
            r:needlePtr++; Bump pointers
            goto compare_loop; Go check another char
        true_return:; Done
            r:one = 1; TODO: Support returning int literals
            return r:one;
        false_return:; Done
            r:zero = 0; TODO: Support returning int literals
            return r:zero;
    `));

export const stringCopy: RuntimeFunctionGenerator = memoize(_bytesInWord =>
    parseFunctionOrDie(`
    (function) string_copy(r:source, r:destination):; Copy string pointer to by first argument to second argument
        string_copy_loop:; Copy a byte
            r:currentChar = *r:source; Load next char from string
            *r:destination = r:currentChar; Write char to output
            goto string_copy_return if r:currentChar == 0; If at end, return
            r:source++; Else increment to next char
            r:destination++; Increment output too
            goto string_copy_loop; and go keep copying
        string_copy_return:; Done
    `));

export const printWithPrintRuntimeFunction: RuntimeFunctionGenerator = memoize(_bytesInWord =>
    parseFunctionOrDie(`
    (function) print(r:str):
        r:result = syscall print r:str;
        return r:result;
    `));

export const printWithWriteRuntimeFunction: RuntimeFunctionGenerator = memoize(_bytesInWord =>
    parseFunctionOrDie(`
    (function) print(r:str):
        r:len = length(r:str); Get str length
        r:result = syscall print 1 r:str r:len; 1: fd of stdout. r:str: ptr to data to write. r:len: length to write
        return r:result;
   `));

export const readIntDirect: RuntimeFunctionGenerator = memoize(_bytesInWord =>
    parseFunctionOrDie(`
        (function) readInt():
              r:result = syscall readInt;
              return r:result;
    `));

export const readIntThroughSyscall: RuntimeFunctionGenerator = memoize(_bytesInWord => {
    const stdinFd = 0;
    const bufferSize = 10;
    return parseFunctionOrDie(`
        (function) readInt():
            r:buffer = my_malloc(${bufferSize}); malloc 10 byte buffer because why not TODO
            r:readResult = syscall read ${stdinFd} r:buffer ${bufferSize};
            r:negativeOne = -1; goto does not support literals
            goto read_failed if r:readResult == r:negativeOne; syscall failed
            intFromString(r:buffer); parse int and return
            my_free(); Free the buffer
            goto readIntExit; result already in result
        read_failed:; label
            r:err = &${errors.readIntFailed.name}; Error to print
            syscall print r:err; syscall
            syscall exit -1; syscall
        readIntExit:; exit
    `);
});

// TODO: figure out a way to verify that this is working
export const verifyNoLeaks: RuntimeFunctionGenerator = memoize(bytesInWord =>
    parseFunctionOrDie(`
    (function) verify_no_leaks():
        r:currentBlockPointer = &first_block; Load first block address
        r:currentBlockPointer = *(r:currentBlockPointer + ${0 * bytesInWord
        }); Load first block pointer
    verify_no_leaks_loop:; verify_no_leaks_loop
        goto verify_no_leaks_return if r:currentBlockPointer == 0; Last block, can return now
        r:currentData = *(r:currentBlockPointer + ${2 * bytesInWord}); data = block->free
        r:one = 1; Need for comparison
        goto verify_no_leaks_advance_pointers if r:currentData == r:one; Don't error if free
        r:err = &${errors.leaksDetected.name}; Error to print
        syscall print r:err; syscall
        syscall exit -1; syscall
    verify_no_leaks_advance_pointers:; verify_no_leaks_advance_pointers
        r:currentBlockPointer = *(r:currentBlockPointer + ${1 * bytesInWord
        }); block = block->next
        goto verify_no_leaks_loop; Check next block
    verify_no_leaks_return:; All done
    `));

export const stringConcatenateRuntimeFunction: RuntimeFunctionGenerator = memoize(_bytesInWord =>
    parseFunctionOrDie(`
    (function) string_concatenate(r:lhs, r:rhs, r:dest):
        write_left_loop:; Append left string
            r:currentChar = *r:lhs; Load byte from left
            goto copy_from_right if r:currentChar == 0; If end of left, start copying right
            *r:dest = r:currentChar; Write byte from left
            r:lhs++; Bump left pointer
            r:dest++; Bump out pointer
            goto write_left_loop; Loop to next char
        copy_from_right:; Append right string
            r:currentChar = *r:rhs; Load byte from right
            *r:dest = r:currentChar; Copy right byte (incl. null)
            goto concatenate_return if r:currentChar == 0; If we just wrote null, we are done
            r:rhs++; Bump right pointer
            r:dest++; Bump out pointer
            goto copy_from_right; Go copy next char
        concatenate_return:; Exit. TODO: repair input pointers?
    `));

export const stringEqualityRuntimeFunction: RuntimeFunctionGenerator = _bytesInWord =>
    parseFunctionOrDie(`
    (function) stringEquality(r:lhs, r:rhs):
            r:result = 1; Result = true (will write false if diff found)
        stringEquality_loop:; Check a char
            r:leftByte = *r:lhs; Load left char into temporary
            r:rightByte = *r:rhs; Load right char into temporary
            goto stringEquality_return_false if r:leftByte != r:rightByte; Inequal: return false
            goto stringEquality_return if r:leftByte == 0; Both side are equal. If both sides are null, return.
            r:lhs++; Bump lhs to next char
            r:rhs++; Bump rhs to next char
            goto stringEquality_loop; Check next char
        stringEquality_return_false:; stringEquality_return_false
            r:result = 0; Set result to false
        stringEquality_return:; Exit
            return r:result;
    `);

// TODO: merge adjacent free blocks
// TOOD: check if already free
export const myFreeRuntimeFunction: RuntimeFunctionGenerator = memoize(bytesInWord =>
    parseFunctionOrDie(`
    (function) my_free(r:ptr):
            r:zero = 0; Need a zero
            goto free_null_check_passed if r:ptr != r:zero; Not freeing null check passed
            r:err = &${errors.freeNull.name}; Error to print
            syscall print r:err; Print
            syscall exit -1; Exit
        free_null_check_passed:; Not attempting to free null
            r:one = 1; Need a 1
            r:managementBlockSize = ${3 * bytesInWord}; 3 words for management
            r:ptr = r:ptr - r:managementBlockSize; Get management block ptr
            *(r:ptr + ${2 * bytesInWord}) = r:one; block->free = true
    `));

// TODO: return error if string doesn't contain an int
// @ts-ignore
export const intFromString: RuntimeFunctionGenerator = memoize(bytesInWord => {
    return parseFunctionOrDie(`
    (function) intFromString(r:in):
        r:result = 0; Accumulate into here
        r:input = r:in; Make a copy so we can modify it TODO is this necessary?
    add_char:; comment
        r:currentChar = *r:input; load a char
        goto exit if r:currentChar == 0; Found the null terminator; done
        r:fortyEight = 48; forty eight
        r:currentNum = r:currentChar - r:fortyEight; Subtract '0' to get actual number
        r:ten = 10; ten
        r:result = r:result * r:ten; Previous digit was 10x
        r:result = r:result + r:currentNum; Add the num
        r:input++; Get next char in next loop iteration
        goto add_char; comment
    exit:; comment
        return r:result;
    `);
});

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
]
