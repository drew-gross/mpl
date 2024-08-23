import debug from './util/debug';
import join from './util/join';
const { sum } = require('./mpl/sum.mpl'); // tslint:disable-line
import { Variable } from './api';
import { RegisterAgnosticTargetInfo } from './TargetInfo';
import { TypeError } from './TypeError';
import * as deepEqual from 'deep-equal';

export type ProductComponent = {
    name: string;
    type: Type;
};

type Permission = 'stdout';
export type TypeReference = { namedType: string };

export type String = { kind: 'String' };
export type Integer = { kind: 'Integer' };
export type Boolean = { kind: 'Boolean' };
export type Function = {
    kind: 'Function';
    permissions: Permission[];
    arguments: (Type | TypeReference)[];
    returnType: Type | TypeReference;
};
export type List = { kind: 'List'; of: Type };
export type Product = { kind: 'Product'; members: ProductComponent[] };
export type Type = {
    type: String | Integer | Boolean | Function | List | Product;
    methods?: Function[];
    original?: TypeReference;
};

export const toString = (type: Type): string => {
    // TODO: Include the original in here somehow?
    switch (type.type.kind) {
        case 'String':
        case 'Integer':
        case 'Boolean':
            return type.type.kind;
        case 'Function':
            return type.type.kind + '<' + join(type.type.arguments.map(toString), ', ') + '>';
        case 'Product':
            return (
                '{' +
                type.type.members.map(member => `${member.name}: ${toString(member.type)}`) +
                '}'
            );
        case 'List':
            return `${toString(type.type.of)}[]`;
        default:
            throw debug(`Unhandled kindpi in type toString: ${(type.type as any).kind}`);
    }
};

export type TypeDeclaration = { name: string; type: Type };

export const resolve = (
    unresolved: Type | TypeReference,
    availableTypes,
    sourceLocation
): Type | { errors: TypeError[]; newVariables: Variable[] } => {
    if (!('namedType' in unresolved)) {
        return unresolved;
    }
    if (!availableTypes) debug('no declarations');
    const type = availableTypes.find(d => d.name == unresolved.namedType);
    if (!type) {
        return {
            errors: [
                {
                    kind: 'unknownType',
                    name: (unresolved as TypeReference).namedType,
                    sourceLocation,
                },
            ],
            newVariables: [],
        };
    }
    return {
        type: type.type.type, // lol
        original: unresolved,
    };
};

export const equal = (a: Type, b: Type): boolean => {
    // Should we allow assigning one product to another if they have different names but identical members? That would be "structural typing" which I'm not sure I want.
    if (!deepEqual(a.original, b.original)) return false;
    if (a.type.kind == 'Function' && b.type.kind == 'Function') {
        if (a.type.arguments.length != b.type.arguments.length) {
            return false;
        }
        for (let i = 0; i < a.type.arguments.length; i++) {
            const tA = a.type.arguments[i];
            if ('namedType' in tA) {
                throw debug('need to handle refs here');
            }
            const tB = b.type.arguments[i];
            if ('namedType' in tB) {
                throw debug('need to handle refs here');
            }
            if (!equal(tA, tB)) {
                return false;
            }
        }
        return true;
    }
    if (a.type.kind == 'Product' && b.type.kind == 'Product') {
        const bProduct = b.type;
        const allInLeftPresentInRight = a.type.members.every(memberA =>
            bProduct.members.some(
                memberB => memberA.name == memberB.name && equal(memberA.type, memberB.type)
            )
        );
        const aProduct = a.type;
        const allInRightPresentInLeft = b.type.members.every(memberB =>
            aProduct.members.some(
                memberA => memberA.name == memberB.name && equal(memberA.type, memberB.type)
            )
        );
        return allInLeftPresentInRight && allInRightPresentInLeft;
    }
    if (a.type.kind == 'List' && b.type.kind == 'List') {
        return equal(a.type.of, b.type.of);
    }
    return a.type.kind == b.type.kind;
};

export const builtinTypes: { [index: string]: Type } = {
    String: { type: { kind: 'String' } },
    Integer: { type: { kind: 'Integer' } },
    Boolean: { type: { kind: 'Boolean' } },
};

// TODO: Require these to be imported in user code
export const builtinFunctions: Variable[] = [
    {
        name: 'length',
        type: {
            type: {
                kind: 'Function',
                arguments: [builtinTypes.String],
                permissions: [],
                returnType: builtinTypes.Integer,
            },
            methods: [],
        },
        exported: false,
    },
    {
        name: 'startsWith',
        type: {
            type: {
                kind: 'Function',
                arguments: [builtinTypes.String, builtinTypes.String],
                permissions: [],
                returnType: builtinTypes.Boolean,
            },
            methods: [],
        },
        exported: false,
    },
    {
        name: 'print',
        type: {
            type: {
                kind: 'Function',
                arguments: [builtinTypes.String],
                permissions: [],
                returnType: builtinTypes.Integer,
            },
            methods: [],
        },
        exported: false,
    },
    {
        name: 'readInt',
        type: {
            type: {
                kind: 'Function',
                arguments: [],
                permissions: ['stdout'],
                returnType: builtinTypes.Integer,
            },
            methods: [],
        },
        exported: false,
    },
];

export const typeSize = (
    targetInfo: RegisterAgnosticTargetInfo,
    type: Type,
    typeDeclarations: TypeDeclaration[]
): number => {
    switch (type.type.kind) {
        case 'List':
            // Pointer + size
            return targetInfo.bytesInWord * 2;
        case 'Product':
            return sum(
                type.type.members.map(m => typeSize(targetInfo, m.type, typeDeclarations))
            );
        case 'Boolean':
        case 'Function':
        case 'String':
        case 'Integer':
            return targetInfo.bytesInWord;
        default:
            throw debug(`${(type as any).kind} unhandled in typeSize`);
    }
};
