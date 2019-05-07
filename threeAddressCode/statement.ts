import { toString as registerToString, Register } from '../register.js';
import { filter, FilterPredicate } from '../util/list/filter.js';

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
    | { kind: 'stackAllocateAndStorePointer'; bytes: number; register: Register }
    // Spilling
    | { kind: 'spill'; register: Register; offset: number }
    | { kind: 'unspill'; register: Register; offset: number }
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
    | { kind: 'syscall'; name: SyscallName; arguments: (Register | number)[]; destination: Register | undefined }
    | { kind: 'callByName'; function: string }
    | { kind: 'callByRegister'; function: Register }
    | { kind: 'returnToCaller' });

const syscallArgToString = (regOrNumber: number | Register): string => {
    if (typeof regOrNumber == 'number') {
        return regOrNumber.toString();
    } else {
        return registerToString(regOrNumber);
    }
};

const toStringWithoutComment = (tas: Statement): string => {
    switch (tas.kind) {
        case 'empty':
            return '';
        case 'syscall':
            const args = tas.arguments.map(syscallArgToString).join(' ');
            if (tas.destination) {
                return `syscalld ${tas.name} ${registerToString(tas.destination)} ${args}`;
            }
            return `syscall ${tas.name} ${args}`;
        case 'move':
            return `${registerToString(tas.to)} = ${registerToString(tas.from)}`;
        case 'loadImmediate':
            return `${registerToString(tas.destination)} = ${tas.value}`;
        case 'addImmediate':
            return `${registerToString(tas.register)} += ${tas.amount}`;
        case 'subtract':
            return `${registerToString(tas.destination)} = ${registerToString(tas.lhs)} - ${registerToString(tas.rhs)}`;
        case 'add':
            return `${registerToString(tas.destination)} = ${registerToString(tas.lhs)} + ${registerToString(tas.rhs)}`;
        case 'multiply':
            return `${registerToString(tas.destination)} = ${registerToString(tas.lhs)} * ${registerToString(tas.rhs)}`;
        case 'increment':
            return `${registerToString(tas.register)}++`;
        case 'label':
        case 'functionLabel':
            return `${tas.name}:`;
        case 'goto':
            return `goto ${tas.label}`;
        case 'gotoIfEqual':
            return `goto ${tas.label} if ${registerToString(tas.lhs)} == ${registerToString(tas.rhs)}`;
        case 'gotoIfNotEqual':
            if (typeof tas.rhs == 'number') {
                return `goto ${tas.label} if ${registerToString(tas.lhs)} != ${tas.rhs}`;
            }
            return `goto ${tas.label} if ${registerToString(tas.lhs)} != ${registerToString(tas.rhs)}`;
        case 'gotoIfZero':
            return `goto ${tas.label} if ${registerToString(tas.register)} == 0`;
        case 'gotoIfGreater':
            return `goto ${tas.label} if ${registerToString(tas.lhs)} > ${registerToString(tas.rhs)}`;
        case 'storeGlobal':
            return `*${tas.to} = ${registerToString(tas.from)}`;
        case 'loadGlobal':
            return `${registerToString(tas.to)} = ${tas.from}`;
        case 'loadSymbolAddress':
            return `${registerToString(tas.to)} = &${tas.symbolName}`;
        case 'storeMemory':
            return `*(${registerToString(tas.address)} + ${tas.offset}) = ${registerToString(tas.from)}`;
        case 'storeMemoryByte':
            return `*${registerToString(tas.address)} = ${registerToString(tas.contents)}`;
        case 'storeZeroToMemory':
            return `*(${registerToString(tas.address)} + ${tas.offset}) = 0`;
        case 'loadMemory':
            return `${registerToString(tas.to)} = *(${registerToString(tas.from)} + ${tas.offset})`;
        case 'loadMemoryByte':
            return `${registerToString(tas.to)} = *${registerToString(tas.address)}`;
        case 'callByRegister':
            return `${registerToString(tas.function)}()`;
        case 'callByName':
            return `${tas.function}()`;
        case 'returnToCaller':
            return `return`;
        case 'stackAllocateAndStorePointer':
            return `${registerToString(tas.register)} = alloca(${tas.bytes})`;
        case 'spill':
            return `spill:${tas.offset} ${registerToString(tas.register)}`;
        case 'unspill':
            return `unspill:${tas.offset} ${registerToString(tas.register)}`;
    }
};

export const toString = (tas: Statement): string => `${toStringWithoutComment(tas)}; ${tas.why}`;

export const reads = (tas: Statement): Register[] => {
    switch (tas.kind) {
        case 'empty':
            return [];
        case 'syscall':
            const predicate: FilterPredicate<Register | number, Register> = (arg: Register | number): arg is Register =>
                typeof arg !== 'number';
            return filter<Register | number, Register>(tas.arguments, predicate);
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
        case 'callByRegister':
            return [tas.function, 'functionArgument1', 'functionArgument2', 'functionArgument3'];
        case 'label':
        case 'callByName':
        case 'functionLabel':
        case 'returnToCaller':
        case 'goto':
            return ['functionArgument1', 'functionArgument2', 'functionArgument3'];
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
        case 'stackAllocateAndStorePointer':
            return [];
        case 'unspill':
            return [];
        case 'spill':
            return [tas.register];
    }
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
            return [];
        case 'label':
        case 'callByName':
        case 'functionLabel':
        case 'returnToCaller':
        case 'goto':
            return [];
        case 'gotoIfEqual':
        case 'gotoIfNotEqual':
        case 'gotoIfGreater':
            return [];
        case 'gotoIfZero':
            return [];
        case 'stackAllocateAndStorePointer':
            return [tas.register];
        case 'unspill':
            return [tas.register];
        case 'spill':
            return [];
    }
};
