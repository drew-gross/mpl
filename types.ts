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
export type NameRef = { kind: 'NameRef'; namedType: string };

export type Type = String | Integer | Boolean | Function | Product | NameRef;

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

export type TypeDeclaration = { name: string; type: Type };

export const equal = (a: Type, b: Type, typeDeclarations: TypeDeclaration[]): boolean => {
    if (a.kind == 'NameRef' && b.kind == 'NameRef') {
        return a.namedType == b.namedType;
    }
    let resolvedA = a;
    if (resolvedA.kind == 'NameRef') {
        typeDeclarations.forEach(({ name, type }) => {
            if ((resolvedA as any).name == name) {
                resolvedA = type;
            }
        });
        if (resolvedA.kind == 'NameRef') {
            return false;
        }
    }
    let resolvedB = b;
    if (resolvedB.kind == 'NameRef') {
        typeDeclarations.forEach(({ name, type }) => {
            if ((resolvedB as any).namedType == name) {
                resolvedB = type;
            }
        });
        if (resolvedB.kind == 'NameRef') {
            return false;
        }
    }

    if (resolvedA.kind == 'Function' && resolvedB.kind == 'Function') {
        if (resolvedA.arguments.length != resolvedB.arguments.length) {
            return false;
        }
        for (let i = 0; i < resolvedA.arguments.length; i++) {
            if (!equal(resolvedA.arguments[i], resolvedB.arguments[i], typeDeclarations)) {
                return false;
            }
        }
        return true;
    }
    if (resolvedA.kind == 'Product' && resolvedB.kind == 'Product') {
        const allInLeftPresentInRight = resolvedA.members.every(memberA =>
            (resolvedB as any).members.some(
                memberB => memberA.name == memberB.name && equal(memberA.type, memberB.type, typeDeclarations)
            )
        );
        const allInRightPresentInLeft = resolvedB.members.every(memberB =>
            (resolvedA as any).members.some(
                memberA => memberA.name == memberB.name && equal(memberA.type, memberB.type, typeDeclarations)
            )
        );
        return allInLeftPresentInRight && allInRightPresentInLeft;
    }
    return resolvedA.kind == resolvedB.kind;
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
