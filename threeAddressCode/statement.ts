import { Register, toString as s } from './Register';
import { filter, FilterPredicate } from '../util/list/filter';
import join from '../util/join';
import debug from '../util/debug';

type SyscallName = 'printInt' | 'print' | 'sbrk' | 'mmap' | 'exit';

export type StackLocation =
    | { kind: 'argument'; argNumber: number }
    | { kind: 'spill'; slotNumber: number };

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
    // Stack is used for many reasons. Each stack slot has a name at this stage, a stack slot number will be assigned later.
    | { kind: 'storeStack'; register: Register; location: StackLocation }
    | { kind: 'loadStack'; register: Register; location: StackLocation }
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

const sOrV = (data: Register | number) => {
    if (typeof data == 'number') {
        return data.toString();
    } else {
        return s(data);
    }
};

const toStringWithoutComment = (tas: Statement): string => {
    switch (tas.kind) {
        case 'empty':
            return '';
        case 'syscall': {
            const args = tas.arguments.map(sOrV).join(' ');
            if (tas.destination) {
                return `${s(tas.destination)} = syscall ${tas.name} ${args}`;
            } else {
                return `syscall ${tas.name} ${args}`;
            }
        }
        case 'move':
            return `${s(tas.to)} = ${s(tas.from)}`;
        case 'loadImmediate':
            return `${s(tas.destination)} = ${tas.value}`;
        case 'addImmediate':
            return `${s(tas.register)} += ${tas.amount}`;
        case 'subtract':
            return `${s(tas.destination)} = ${s(tas.lhs)} - ${s(tas.rhs)}`;
        case 'add':
            return `${s(tas.destination)} = ${s(tas.lhs)} + ${s(tas.rhs)}`;
        case 'multiply':
            return `${s(tas.destination)} = ${s(tas.lhs)} * ${s(tas.rhs)}`;
        case 'increment':
            return `${s(tas.register)}++`;
        case 'label':
        case 'functionLabel':
            return `${tas.name}:`;
        case 'goto':
            return `goto ${tas.label}`;
        case 'gotoIfEqual':
            return `goto ${tas.label} if ${s(tas.lhs)} == ${s(tas.rhs)}`;
        case 'gotoIfNotEqual':
            if (typeof tas.rhs == 'number') {
                return `goto ${tas.label} if ${s(tas.lhs)} != ${tas.rhs}`;
            }
            return `goto ${tas.label} if ${s(tas.lhs)} != ${s(tas.rhs)}`;
        case 'gotoIfZero':
            return `goto ${tas.label} if ${s(tas.register)} == 0`;
        case 'gotoIfGreater':
            return `goto ${tas.label} if ${s(tas.lhs)} > ${s(tas.rhs)}`;
        case 'storeGlobal':
            return `*${tas.to} = ${s(tas.from)}`;
        case 'loadGlobal':
            return `${s(tas.to)} = ${tas.from}`;
        case 'loadSymbolAddress':
            return `${s(tas.to)} = &${tas.symbolName}`;
        case 'storeMemory':
            return `*(${s(tas.address)} + ${tas.offset}) = ${s(tas.from)}`;
        case 'storeMemoryByte':
            return `*${s(tas.address)} = ${s(tas.contents)}`;
        case 'storeZeroToMemory':
            return `*(${s(tas.address)} + ${tas.offset}) = 0`;
        case 'loadMemory':
            return `${s(tas.to)} = *(${s(tas.from)} + ${tas.offset})`;
        case 'loadMemoryByte':
            return `${s(tas.to)} = *${s(tas.address)}`;
        case 'callByRegister': {
            if (!tas.arguments) throw debug('bad argumnets');
            const args = join(tas.arguments.map(sOrV), ', ');
            if (tas.destination) {
                return `${s(tas.destination)} = ${s(tas.function)}(${args})`;
            } else {
                return `${s(tas.function)}(${args})`;
            }
        }
        case 'callByName': {
            if (!tas.arguments) throw debug('bad argumnets');
            const args = join(tas.arguments.map(sOrV), ', ');
            if (tas.destination) {
                return `${s(tas.destination)} = ${tas.function}(${args})`;
            } else {
                return `${tas.function}(${args})`;
            }
        }
        case 'return':
            return `return ${s(tas.register)};`;
        case 'alloca':
            return `${s(tas.register)} = alloca(${tas.bytes})`;
        case 'storeStack':
            return `storeStack:${s(tas.register)}`;
        case 'loadStack':
            return `loadStack:${s(tas.register)}`;
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
        // storeStack/loadStack doesn't really fit into the reads/write paradigm correctly, because it _implements_ reads/writes. Semantics: After we storeStack something, it's not live anymore, so it's a "write" since writes kill a register. After we loadStack something, we can kinda do whatever (whether it's live depends on whether future readers exist)TODO: handle it better somehow
        case 'loadStack':
            return [];
        case 'storeStack':
            return [];
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
            return [tas.register];
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
        // storeStack/loadStack doesn't really fit into the reads/write paradigm correctly, because it _implements_ reads/writes. Semantics: After we storeStack something, it's not live anymore, so it's a "write" since writes kill a register. After we loadStack something, we can kinda do whatever (whether it's live depends on whether future readers exist)TODO: handle it better somehow
        case 'storeStack':
        case 'loadStack':
            return [tas.register];
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
        case 'storeStack':
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
        case 'loadStack':
            return false;
    }
    throw debug(`kind ${(tas as any).kind} missing in hasSideEffects`);
};
