import debug from '../util/debug.js';
import { toString as registerToString, Register } from '../register.js';
import { ThreeAddressStatement } from './generator.js';

const syscallArgToString = (regOrNumber: number | Register): string => {
    if (typeof regOrNumber == 'number') {
        return regOrNumber.toString();
    } else {
        return registerToString(regOrNumber);
    }
};

const toStringWithoutComment = (tas: ThreeAddressStatement): string => {
    switch (tas.kind) {
        case 'comment':
            return ``;
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
        // Should be completely covered
    }
};

export default (tas: ThreeAddressStatement): string => `${toStringWithoutComment(tas)} # ${tas.why}`;
