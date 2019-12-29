import { toString as rToS, Register } from '../register.js';
import { filter, FilterPredicate } from '../util/list/filter.js';
import join from '../util/join.js';
import debug from '../util/debug.js';

type SyscallName = 'printInt' | 'print' | 'sbrk' | 'mmap' | 'exit';

export type Statement = { why: string } & (
    | { kind: 'empty' }
    // Arithmetic
    | { kind: 'move'; from: Register; to: Register }
    | { kind: 'loadImmediate'; value: number; destination: Register }
    | { kind: 'addImmediate'; register: Register; amount: number }
    | { kind: 'subtract'; lhs: Register; rhs: Register; destination: Register }
    | { kind: 'add'; lhs: Register; rhs: Register; destination: Register }
    | { kind: 'multiply'; lhs: Register; rhs: Register; destination: Register }
    | { kind: 'increment'; register: Register }
    // Labels
    | { kind: 'label'; name: string }
    | { kind: 'functionLabel'; name: string }
    // Stack management
    | { kind: 'alloca'; bytes: number; register: Register }
    // Spilling
    | { kind: 'spill'; register: Register }
    | { kind: 'unspill'; register: Register }
    // Branches
    | { kind: 'goto'; label: string }
    | { kind: 'gotoIfEqual'; lhs: Register; rhs: Register; label: string }
    | { kind: 'gotoIfNotEqual'; lhs: Register; rhs: Register | number; label: string }
    | { kind: 'gotoIfZero'; register: Register; label: string }
    | { kind: 'gotoIfGreater'; lhs: Register; rhs: Register; label: string }
    // Memory Writes
    | { kind: 'storeGlobal'; from: Register; to: string }
    | { kind: 'storeMemory'; from: Register; address: Register; offset: number }
    | { kind: 'storeMemoryByte'; address: Register; contents: Register }
    | { kind: 'storeZeroToMemory'; address: Register; offset: number }
    // Memory reads
    | { kind: 'loadGlobal'; from: string; to: Register }
    | { kind: 'loadMemory'; from: Register; to: Register; offset: number }
    | { kind: 'loadMemoryByte'; address: Register; to: Register }
    | { kind: 'loadSymbolAddress'; to: Register; symbolName: string }
    // Function calls
    | {
          kind: 'syscall';
          name: SyscallName;
          arguments: (Register | number)[];
          destination: Register | null;
      }
    | {
          kind: 'callByName';
          function: string;
          arguments: (Register | number)[];
          destination: Register | null;
      }
    | {
          kind: 'callByRegister';
          function: Register;
          arguments: (Register | number)[];
          destination: Register | null;
      }
    | { kind: 'return'; register: Register }
);

const syscallArgToString = (regOrNumber: number | Register): string => {
    if (typeof regOrNumber == 'number') {
        return regOrNumber.toString();
    } else {
        return rToS(regOrNumber);
    }
};

const toStringWithoutComment = (tas: Statement): string => {
    switch (tas.kind) {
        case 'empty':
            return '';
        case 'syscall': {
            if (tas.destination) {
                const args = tas.arguments.map(syscallArgToString).join(' ');
                return `${rToS(tas.destination)} = syscall ${tas.name} ${args}`;
            } else {
                const args = tas.arguments.map(syscallArgToString).join(' ');
                return `syscall ${tas.name} ${args}`;
            }
        }
        case 'move':
            return `${rToS(tas.to)} = ${rToS(tas.from)}`;
        case 'loadImmediate':
            return `${rToS(tas.destination)} = ${tas.value}`;
        case 'addImmediate':
            return `${rToS(tas.register)} += ${tas.amount}`;
        case 'subtract':
            return `${rToS(tas.destination)} = ${rToS(tas.lhs)} - ${rToS(tas.rhs)}`;
        case 'add':
            return `${rToS(tas.destination)} = ${rToS(tas.lhs)} + ${rToS(tas.rhs)}`;
        case 'multiply':
            return `${rToS(tas.destination)} = ${rToS(tas.lhs)} * ${rToS(tas.rhs)}`;
        case 'increment':
            return `${rToS(tas.register)}++`;
        case 'label':
        case 'functionLabel':
            return `${tas.name}:`;
        case 'goto':
            return `goto ${tas.label}`;
        case 'gotoIfEqual':
            return `goto ${tas.label} if ${rToS(tas.lhs)} == ${rToS(tas.rhs)}`;
        case 'gotoIfNotEqual':
            if (typeof tas.rhs == 'number') {
                return `goto ${tas.label} if ${rToS(tas.lhs)} != ${tas.rhs}`;
            }
            return `goto ${tas.label} if ${rToS(tas.lhs)} != ${rToS(tas.rhs)}`;
        case 'gotoIfZero':
            return `goto ${tas.label} if ${rToS(tas.register)} == 0`;
        case 'gotoIfGreater':
            return `goto ${tas.label} if ${rToS(tas.lhs)} > ${rToS(tas.rhs)}`;
        case 'storeGlobal':
            return `*${tas.to} = ${rToS(tas.from)}`;
        case 'loadGlobal':
            return `${rToS(tas.to)} = ${tas.from}`;
        case 'loadSymbolAddress':
            return `${rToS(tas.to)} = &${tas.symbolName}`;
        case 'storeMemory':
            return `*(${rToS(tas.address)} + ${tas.offset}) = ${rToS(tas.from)}`;
        case 'storeMemoryByte':
            return `*${rToS(tas.address)} = ${rToS(tas.contents)}`;
        case 'storeZeroToMemory':
            return `*(${rToS(tas.address)} + ${tas.offset}) = 0`;
        case 'loadMemory':
            return `${rToS(tas.to)} = *(${rToS(tas.from)} + ${tas.offset})`;
        case 'loadMemoryByte':
            return `${rToS(tas.to)} = *${rToS(tas.address)}`;
        case 'callByRegister': {
            if (!tas.arguments) throw debug('bad argumnets');
            const args = join(tas.arguments.map(rToS), ', ');
            if (tas.destination) {
                return `${rToS(tas.destination)} = ${rToS(tas.function)}(${args})`;
            } else {
                return `${rToS(tas.function)}(${args})`;
            }
        }
        case 'callByName': {
            if (!tas.arguments) throw debug('bad argumnets');
            const args = join(tas.arguments.map(rToS), ', ');
            if (tas.destination) {
                return `${rToS(tas.destination)} = ${tas.function}(${args})`;
            } else {
                return `${tas.function}(${args})`;
            }
        }
        case 'return':
            return `return ${rToS(tas.register)};`;
        case 'alloca':
            return `${rToS(tas.register)} = alloca(${tas.bytes})`;
        case 'spill':
            return `spill:${rToS(tas.register)}`;
        case 'unspill':
            return `unspill:${rToS(tas.register)}`;
    }
};

const preceedingWhitespace = (tas: Statement): string => {
    switch (tas.kind) {
        case 'label':
            return '';
        case 'functionLabel':
            return '\n\n';
        default:
            return '    ';
    }
};

export const toString = (tas: Statement): string => {
    return `${preceedingWhitespace(tas)}${toStringWithoutComment(tas)}; ${tas.why.trim()}`;
};

export const reads = (tas: Statement, args: Register[]): Register[] => {
    switch (tas.kind) {
        case 'empty':
            return [];
        case 'syscall': {
            const predicate: FilterPredicate<Register | number, Register> = (
                arg: Register | number
            ): arg is Register => typeof arg !== 'number';
            return filter<Register | number, Register>(tas.arguments, predicate);
        }
        case 'move':
            return [tas.from];
        case 'loadImmediate':
            return [];
        case 'addImmediate':
        case 'increment':
            return [tas.register];
        case 'subtract':
        case 'add':
        case 'multiply':
            return [tas.lhs, tas.rhs];
        case 'storeGlobal':
            return [tas.from];
        case 'loadGlobal':
            return [];
        case 'storeMemory':
            return [tas.from, tas.address];
        case 'storeMemoryByte':
            return [tas.contents, tas.address];
        case 'storeZeroToMemory':
            return [tas.address];
        case 'loadMemory':
            return [tas.from];
        case 'loadMemoryByte':
            return [tas.address];
        case 'loadSymbolAddress':
            return [];
        case 'callByRegister': {
            const predicate: FilterPredicate<Register | number, Register> = (
                arg: Register | number
            ): arg is Register => typeof arg !== 'number';
            return [tas.function, ...filter(tas.arguments, predicate)];
        }
        case 'callByName': {
            const predicate: FilterPredicate<Register | number, Register> = (
                arg: Register | number
            ): arg is Register => typeof arg !== 'number';
            return filter(tas.arguments, predicate);
        }
        case 'return':
            return [tas.register];
        case 'label':
        case 'functionLabel':
        case 'goto':
            // TODO: args should not be reads; these instructions should have no reads
            return args;
        case 'gotoIfEqual':
        case 'gotoIfNotEqual':
        case 'gotoIfGreater':
            const result = [tas.lhs];
            if (typeof tas.rhs != 'number') {
                result.push(tas.rhs);
            }
            return result;
        case 'gotoIfZero':
            return [tas.register];
        case 'alloca':
            return [];
        case 'unspill':
            return [];
        case 'spill':
            return [tas.register];
    }
    throw debug(`kind ${(tas as any).kind} missing in reads`);
};

export const writes = (tas: Statement): Register[] => {
    switch (tas.kind) {
        case 'empty':
            return [];
        case 'syscall':
            return tas.destination ? [tas.destination] : [];
        case 'move':
            return [tas.to];
        case 'loadImmediate':
            return [tas.destination];
        case 'addImmediate':
        case 'increment':
            return [];
        case 'subtract':
        case 'add':
        case 'multiply':
            return [tas.destination];
        case 'storeGlobal':
            return [];
        case 'loadGlobal':
            return [tas.to];
        case 'storeMemory':
            return [];
        case 'storeMemoryByte':
            return [];
        case 'storeZeroToMemory':
            return [];
        case 'loadMemory':
            return [tas.to];
        case 'loadMemoryByte':
            return [tas.to];
        case 'loadSymbolAddress':
            return [tas.to];
        case 'callByRegister':
        case 'callByName':
            return tas.destination ? [tas.destination] : [];
        case 'label':
        case 'functionLabel':
        case 'return':
        case 'goto':
            return [];
        case 'gotoIfEqual':
        case 'gotoIfNotEqual':
        case 'gotoIfGreater':
            return [];
        case 'gotoIfZero':
            return [];
        case 'alloca':
            return [tas.register];
        case 'unspill':
            return [tas.register];
        case 'spill':
            return [];
    }
    throw debug(`kind ${(tas as any).kind} missing in writes`);
};

// An instruction has side effects if it does anything other than change the registers in it's write()s. Basically exists to prevent removal of functions for having only dead stores where their stores are to things other than registers.
export const hasSideEffects = (tas: Statement): boolean => {
    switch (tas.kind) {
        // Syscalls ultimately cause all user-visible effects
        case 'syscall':
        // Writes to memory are not captured by "writes" but are side effects
        case 'storeGlobal':
        case 'storeMemory':
        case 'storeZeroToMemory':
        case 'storeMemoryByte':
        // These write to the stack
        case 'alloca':
        case 'spill':
        // Labels act as a side effect in that it can't be removed for having no side effects
        case 'label':
        case 'functionLabel':
        case 'return':
        // Control flow affects the "instruction pointer" which is technically a register but we usually don't treat it as one.
        case 'goto':
        case 'gotoIfEqual':
        case 'gotoIfNotEqual':
        case 'gotoIfGreater':
        case 'gotoIfZero':
            return true;
        // TODO: Maybe putting callByRegister and callByNmae here is too restrictive? Part of the point of this language is to ensure that the compiler knows which functions have side effects, so we should be able to say here whether a function call has side effects or not. That said, maybe that optimization should go at a higher level, and this function should assume that any function thats still here has side effects.
        case 'callByRegister':
        case 'callByName':
            return true;
        // Empty instructions are really just comments
        case 'empty':
        // These all change registers so they only have real effects, not side effects.
        case 'move':
        case 'loadImmediate':
        case 'addImmediate':
        case 'increment':
        case 'subtract':
        case 'add':
        case 'multiply':
        case 'loadSymbolAddress':
        case 'loadGlobal':
        case 'loadMemory':
        case 'loadMemoryByte':
        case 'unspill':
            return false;
    }
    throw debug(`kind ${(tas as any).kind} missing in hasSideEffects`);
};
