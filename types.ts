import debug from './util/debug.js';
import join from './util/join.js';
import sum from './util/list/sum.js';
import { VariableDeclaration } from './api.js';
import { TargetInfo } from './threeAddressCode/generator.js';
export type ProductComponent = {
    name: string;
    type: Type;
};

export type String = { kind: 'String' };
export type Integer = { kind: 'Integer' };
export type Boolean = { kind: 'Boolean' };
export type Function = { kind: 'Function'; arguments: Type[] };
export type Product = { kind: 'Product'; name: string; members: ProductComponent[] };
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

// TODO: split Type into ResolveType and Type, and have this function accept Type and return ResolvedType
export const resolve = (t: NameRef, typeDeclarations: TypeDeclaration[]): Type | undefined => {
    const type = typeDeclarations.find(d => d.name == t.namedType);
    return type ? type.type : type; // lol
};

export const equal = (a: Type, b: Type, typeDeclarations: TypeDeclaration[]): boolean => {
    if (a.kind == 'NameRef' && b.kind == 'NameRef') {
        return a.namedType == b.namedType;
    }
    let resolvedA = a;
    if (a.kind == 'NameRef') {
        const resolved = resolve(a, typeDeclarations);
        if (!resolved) return false;
        resolvedA = resolved;
    }
    let resolvedB = b;
    if (b.kind == 'NameRef') {
        const resolved = resolve(b, typeDeclarations);
        if (!resolved) return false;
        resolvedB = resolved;
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
    },
    {
        name: 'print',
        type: {
            kind: 'Function',
            arguments: [builtinTypes.String, builtinTypes.Integer],
        },
    },
];

export const typeSize = (targetInfo: TargetInfo, type: Type, typeDeclarations: TypeDeclaration[]): number => {
    switch (type.kind) {
        case 'Product':
            return sum(type.members.map(m => typeSize(targetInfo, m.type, typeDeclarations)));
        case 'Boolean':
        case 'Function':
        case 'String':
        case 'Integer':
            return targetInfo.alignment;
        case 'NameRef':
            const resolved = resolve(type, typeDeclarations);
            if (!resolved) throw debug('couldnt resolve');
            return typeSize(targetInfo, resolved, typeDeclarations);
        default:
            throw debug(`${(type as any).kind} unhandled in typeSize`);
    }
};
