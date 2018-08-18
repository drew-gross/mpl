import debug from '../util/debug.js';
import { toString as registerToString } from '../register.js';
import { ThreeAddressStatement } from './generator.js';

const toStringWithoutComment = (tas: ThreeAddressStatement): string => {
    switch (tas.kind) {
        case 'comment':
            return ``;
        case 'syscall':
            return 'syscall';
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
            return `goto ${tas.label} if ${registerToString(tas.lhs)} != ${registerToString(tas.rhs)}`;
        case 'gotoIfZero':
            return `goto ${tas.label} if ${registerToString(tas.register)} == 0`;
        case 'gotoIfGreater':
            return `goto ${tas.label} if ${registerToString(tas.lhs)} > ${registerToString(tas.rhs)}`;
        case 'storeGlobal':
            return `*${tas.to} = ${registerToString(tas.from)}`;
        case 'loadGlobal':
            return `${registerToString(tas.to)} = &${tas.from}`;
        case 'storeMemory':
            return `*(${registerToString(tas.address)} + ${tas.offset}) = ${registerToString(tas.from)}`;
        case 'storeMemoryByte':
            return `*${registerToString(tas.address)} = ${registerToString(tas.contents)}`;
        case 'storeZeroToMemory':
            return `*${registerToString(tas.address)} = 0`;
        case 'loadMemory':
            return `${registerToString(tas.to)} = *(${registerToString(tas.from)} + ${tas.offset})`;
        case 'loadMemoryByte':
            return `${registerToString(tas.to)} = *${registerToString(tas.address)}`;
        case 'loadSymbolAddress':
            return `${registerToString(tas.to)} = &${tas.symbolName}`;
        case 'callByRegister':
            return `${registerToString(tas.function)}()`;
        case 'callByName':
            return `${tas.function}()`;
        case 'returnToCaller':
            return `return`;
        default:
            throw debug('Unrecognized RTX kind in toString');
    }
};

export default (tas: ThreeAddressStatement): string => `${toStringWithoutComment(tas)} # ${tas.why}`;
