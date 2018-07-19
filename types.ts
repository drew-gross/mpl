import debug from './util/debug.js';
import join from './util/join.js';
import { VariableDeclaration } from './api.js';

export type ProductComponent = {
    name: string;
    type: Type;
};

export type String = { kind: 'String' };
export type Integer = { kind: 'Integer' };
export type Boolean = { kind: 'Boolean' };
export type Function = { kind: 'Function'; arguments: Type[] };
export type Product = { kind: 'Product'; members: ProductComponent[] };

export type Type = String | Integer | Boolean | Function | Product;

export const toString = (type: Type): string => {
    switch (type.kind) {
        case 'String':
        case 'Integer':
        case 'Boolean':
            return type.kind;
        case 'Function':
            return type.kind + '<' + join(type.arguments.map(toString), ', ') + '>';
        case 'Product':
            return '{' + type.members.map(({ name, type }) => `${name}: ${toString(type)}`) + '}';
        default:
            throw debug('Unhandled kind in type toString');
    }
};

export const equal = (a: Type, b: Type): boolean => {
    if (a.kind == 'Function' && b.kind == 'Function') {
        if (a.arguments.length != b.arguments.length) {
            return false;
        }
        for (let i = 0; i < a.arguments.length; i++) {
            if (!equal(a.arguments[i], b.arguments[i])) {
                return false;
            }
        }
        return true;
    }
    if (a.kind == 'Product' && b.kind == 'Product') {
        const allInLeftPresentInRight = a.members.every(memberA =>
            b.members.some(memberB => memberA.name == memberB.name && equal(memberA.type, memberB.type))
        );
        const allInRightPresentInLeft = b.members.every(memberB =>
            a.members.some(memberA => memberA.name == memberB.name && equal(memberA.type, memberB.type))
        );
        return allInLeftPresentInRight && allInRightPresentInLeft;
    }
    return a.kind == b.kind;
};

export const builtinTypes: { [index: string]: Type } = {
    String: { kind: 'String' },
    Integer: { kind: 'Integer' },
    Boolean: { kind: 'Boolean' },
};
// TODO: Require these to be imported in user code
export const builtinFunctions: VariableDeclaration[] = [
    {
        name: 'length',
        type: {
            kind: 'Function',
            arguments: [builtinTypes.String, builtinTypes.Integer],
        },
        location: 'Global',
    },
    {
        name: 'print',
        type: {
            kind: 'Function',
            arguments: [builtinTypes.String, builtinTypes.Integer],
        },
        location: 'Global',
    },
];
