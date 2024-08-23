import debug from '../util/debug';
import { TokenSpec, LexError } from '../parser-lib/lex';
import { Register } from './Register';
import { Statement } from './Statement';
import {
    Grammar,
    Sequence,
    OneOf,
    Terminal,
    Optional,
    SeparatedList,
    SeparatedListNode,
    Many,
    parseString,
    Ast,
    ParseFailureInfo,
    isListNode,
    isSeparatedListNode,
} from '../parser-lib/parse';
import renderParseError from '../parser-lib/renderParseError';

export type TacToken =
    | 'global'
    | 'function'
    | 'return'
    | 'goto'
    | 'if'
    | 'doubleEqual'
    | 'colon'
    | 'comma'
    | 'number'
    | 'leftBracket'
    | 'rightBracket'
    | 'identifier'
    | 'assign'
    | 'alloca'
    | 'register'
    | 'star'
    | 'plusplus'
    | 'lessThan'
    | 'greaterThan'
    | 'spillSpec'
    | 'plus'
    | 'and'
    | 'minus'
    | 'syscall'
    | 'notEqual'
    | 'plusEqual'
    | 'spillInstruction'
    | 'unspillInstruction'
    | 'statementSeparator';

export const tokenSpecs: TokenSpec<TacToken>[] = [
    { token: '\\(global\\)', type: 'global', toString: x => x },
    { token: '\\(function\\)', type: 'function', toString: x => x },
    {
        token: '\\(spill:\\d+\\)',
        type: 'spillSpec',
        toString: x => x,
        action: s => parseInt(s.slice(7, -1), 10),
    },
    {
        token: 'spill:\\d+', // TODO: fix spill/unspill parsing
        type: 'spillInstruction',
        toString: x => x,
        action: s => parseInt(s.slice(6), 10),
    },
    {
        token: 'unspill:\\d+',
        type: 'unspillInstruction',
        toString: x => x,
        action: s => parseInt(s.slice(8), 10),
    },
    { token: 'return\\b', type: 'return', toString: x => x },
    { token: 'goto', type: 'goto', toString: x => x },
    { token: 'alloca', type: 'alloca', toString: x => x },
    { token: 'r:[a-z]\\w*', type: 'register', toString: x => x, action: x => x },
    { token: 'syscall', type: 'syscall', toString: x => x, action: x => x },
    { token: 'if', type: 'if', toString: x => x },
    { token: '\\:', type: 'colon', toString: _ => ':' },
    { token: '\\,', type: 'comma', toString: _ => ',' },
    { token: '-?\\d+', type: 'number', action: parseInt, toString: x => x.toString() },
    { token: '!=', type: 'notEqual', toString: _ => '!=' },
    { token: '\\+=', type: 'plusEqual', toString: _ => '+=' },
    { token: '==', type: 'doubleEqual', toString: _ => '==' },
    { token: '\\+\\+', type: 'plusplus', toString: _ => '++' },
    { token: '\\+', type: 'plus', toString: _ => '+' },
    { token: '\\(', type: 'leftBracket', toString: _ => '(' },
    { token: '\\)', type: 'rightBracket', toString: _ => ')' },
    { token: '=', type: 'assign', toString: () => '=' },
    { token: '\\*', type: 'star', toString: _ => '*' },
    { token: '\\&', type: 'and', toString: _ => '*' },
    { token: '\\-', type: 'minus', toString: _ => '-' },
    { token: '<', type: 'lessThan', toString: _ => '<' },
    { token: '>', type: 'greaterThan', toString: _ => '>' },
    { token: '[a-z]\\w*', type: 'identifier', action: x => x, toString: x => x },
    { token: ';.*\n?', type: 'statementSeparator', action: x => x, toString: x => x },
];

export type TacAstNode =
    | 'program'
    | 'addressOf'
    | 'global'
    | 'loadImmediate'
    | 'label'
    | 'function'
    | 'instructions'
    | 'sum'
    | 'difference'
    | 'gotoIfEqual'
    | 'gotoIfNotEqual'
    | 'gotoIfGreater'
    | 'instruction'
    | 'store'
    | 'argList'
    | 'syscallArgs'
    | 'offsetStore'
    | 'offsetLoad'
    | 'callByName'
    | 'callByRegister'
    | 'alloca'
    | 'product'
    | 'load'
    | 'spill'
    | 'unspill'
    | 'increment'
    | 'statementSeparator';

const tacTerminal = token => Terminal<TacAstNode, TacToken>(token);
const tacOptional = parser => Optional<TacAstNode, TacToken>(parser);

const identifier = tacTerminal('identifier');
const leftBracket = tacTerminal('leftBracket');
const rightBracket = tacTerminal('rightBracket');
const number = tacTerminal('number');
const register = tacTerminal('register');
const colon = tacTerminal('colon');
const comma = tacTerminal('comma');
const global_ = tacTerminal('global');
const function_ = tacTerminal('function');
const spillSpec = tacTerminal('spillSpec'); // TODO: remove spillspec
const statementSeparator = tacTerminal('statementSeparator');
const assign = tacTerminal('assign');
const star = tacTerminal('star');
const goto = tacTerminal('goto');
const alloca = tacTerminal('alloca');
const if_ = tacTerminal('if');
const doubleEqual = tacTerminal('doubleEqual');
const plusEqual = tacTerminal('plusEqual');
const notEqual = tacTerminal('notEqual');
const plusplus = tacTerminal('plusplus');
const minus = tacTerminal('minus');
const plus = tacTerminal('plus');
const and = tacTerminal('and');
const syscall = tacTerminal('syscall');
const return_ = tacTerminal('return');
const spillInstruction = tacTerminal('spillInstruction');
const unspillInstruction = tacTerminal('unspillInstruction');
const greaterThan = tacTerminal('greaterThan');

export const grammar: Grammar<TacAstNode, TacToken> = {
    program: Sequence('program', [Many('global'), Many('function')]),
    global: Sequence('global', [global_, identifier, colon, identifier, number]),
    function: Sequence('function', [
        function_,
        tacOptional(spillSpec),
        identifier,
        leftBracket,
        'argList',
        rightBracket,
        colon,
        'instructions',
    ]),
    // TODO: make it possible to spcify a Many at the parser entry point, so I can fold Many('instruction') into function, and remove parseInstructions function
    instructions: Many('instruction'),
    instruction: OneOf([
        Sequence('statementSeparator', [statementSeparator]),
        Sequence('label', [identifier, colon, statementSeparator]),
        Sequence('syscall', [
            tacOptional(register),
            tacOptional(assign),
            syscall,
            identifier,
            'syscallArgs',
            statementSeparator,
        ]),
        Sequence('loadImmediate', [register, assign, number, statementSeparator]),
        Sequence('assign', [register, assign, 'data', statementSeparator]),
        Sequence('load', [register, assign, star, 'data', statementSeparator]),
        Sequence('store', [star, 'data', assign, 'data', statementSeparator]),
        Sequence('offsetStore', [
            star,
            leftBracket,
            register,
            plus,
            number,
            rightBracket,
            assign,
            'data',
            statementSeparator,
        ]),
        Sequence('offsetLoad', [
            register,
            assign,
            star,
            leftBracket,
            register,
            plus,
            number,
            rightBracket,
            statementSeparator,
        ]),
        Sequence('difference', [register, assign, 'data', minus, 'data', statementSeparator]),
        Sequence('product', [register, assign, 'data', star, 'data', statementSeparator]),
        Sequence('sum', [register, assign, 'data', plus, 'data', statementSeparator]),
        Sequence('addressOf', [register, assign, and, 'data', statementSeparator]),
        Sequence('gotoIfEqual', [
            goto,
            identifier,
            if_,
            'data',
            doubleEqual,
            'data',
            statementSeparator,
        ]),
        Sequence('gotoIfNotEqual', [
            goto,
            identifier,
            if_,
            'data',
            notEqual,
            'data',
            statementSeparator,
        ]),
        Sequence('gotoIfGreater', [
            goto,
            identifier,
            if_,
            'data',
            greaterThan,
            'data',
            statementSeparator,
        ]),
        Sequence('plusEqual', [register, plusEqual, 'data', statementSeparator]),
        Sequence('goto', [goto, identifier, statementSeparator]),
        Sequence('increment', [register, plusplus, statementSeparator]),
        Sequence('unspill', [unspillInstruction, register, statementSeparator]),
        Sequence('spill', [spillInstruction, register, statementSeparator]),
        Sequence('alloca', [
            register,
            assign,
            alloca,
            leftBracket,
            number,
            rightBracket,
            statementSeparator,
        ]),
        Sequence('callByRegister', [
            register,
            tacOptional(assign),
            tacOptional(register), // TODO: a) combine assignment and register b) once optional parsing is refactored, put the optional on the first register
            leftBracket,
            'argList',
            rightBracket,
            statementSeparator,
        ]),
        Sequence('callByName', [
            tacOptional(register),
            tacOptional(assign),
            identifier,
            leftBracket,
            'argList',
            rightBracket,
            statementSeparator,
        ]),
        Sequence('return', [return_, register, statementSeparator]),
    ]),
    argList: SeparatedList(comma, OneOf([number, register])),
    syscallArgs: Sequence('syscallArgs', [
        tacOptional(identifier),
        Many(OneOf([number, register])),
    ]),
    data: OneOf([identifier, register, number]),
};

const parseSyscallArgs = (ast: Ast<TacAstNode, TacToken>): (Register | number)[] => {
    if (!isListNode(ast)) throw debug('todo');
    return ast.items.map(child => {
        if (isSeparatedListNode(child) || isListNode(child)) {
            throw debug('todo');
        }
        switch (child.type) {
            case 'register':
                if (typeof child.value !== 'string') throw debug('str');
                return parseRegister(child.value);
            case 'number':
                if (typeof child.value !== 'number') throw debug('str');
                return child.value;
            default:
                throw debug(`unhandled case in parseSyscallArgs: ${child.type}`);
        }
    });
};

export const parseArgList = <NodeType, TokenType>(
    ast: SeparatedListNode<NodeType, TokenType>
): (Register | number)[] =>
    ast.items.map((item: Ast<NodeType, TokenType>) => {
        if (isSeparatedListNode(item) || isListNode(item)) {
            throw debug('todo');
        }
        switch (item.type) {
            case 'number':
                return (item as any).value;
            case 'register':
                return parseRegister((item as any).value);
            default:
                throw debug('bad type');
        }
    });

const stripComment = (str: string): string => {
    return str.substring(2, str.length - 1);
};

const isRegister = (data: string): boolean => {
    if (!data.startsWith) debug('no startsWith');
    if (data.startsWith('r:')) {
        return true;
    }
    return false;
};

const parseRegister = (data: string): Register => {
    if (typeof data !== 'string') debug('non-string passed to parseRegister');
    if (data.startsWith('r:')) {
        return new Register(data.substring(2));
    }
    throw debug('invalid register name');
};

export const instructionFromParseResult = (ast: Ast<TacAstNode, TacToken>): Statement => {
    if (isSeparatedListNode(ast) || isListNode(ast)) {
        throw debug('todo');
    }
    const a = ast as any;
    switch (ast.type) {
        case 'assign': {
            const [toReg, _assign, fromReg, comment] = a.sequenceItems;
            const to = parseRegister(toReg.value);
            const from = fromReg.value;
            const why = stripComment(comment.value);
            if (isRegister(from)) {
                return { kind: 'move', to, from: parseRegister(from), why };
            } else {
                return { kind: 'loadGlobal', from, to, why };
            }
        }
        case 'label': {
            const [label, _color, comment] = a.sequenceItems;
            return {
                kind: 'label',
                name: label.value,
                why: stripComment(comment.value),
            };
        }
        case 'load': {
            const [to, _assign, _star, from, comment] = a.sequenceItems;
            return {
                kind: 'loadMemoryByte',
                address: parseRegister(from.value),
                to: parseRegister(to.value),
                why: stripComment(comment.value),
            };
        }
        case 'goto': {
            const [_goto, label, comment] = a.sequenceItems;
            return {
                kind: 'goto',
                label: label.value,
                why: stripComment(comment.value),
            };
        }
        case 'gotoIfEqual': {
            const [_goto, label, _if, lhs, _eq, rhs, comment] = a.sequenceItems;
            if (rhs.value == 0) {
                return {
                    kind: 'gotoIfZero',
                    label: label.value,
                    register: parseRegister(lhs.value),
                    why: stripComment(comment.value),
                };
            }
            if (rhs.type == 'number') {
                return {
                    kind: 'gotoIfEqual',
                    label: label.value,
                    lhs: parseRegister(lhs.value),
                    rhs: parseRegister(rhs.value),
                    why: stripComment(comment.value),
                };
            }
            return {
                kind: 'gotoIfEqual',
                label: label.value,
                lhs: parseRegister(lhs.value),
                rhs: parseRegister(rhs.value),
                why: stripComment(label.value),
            } as any;
        }
        case 'increment': {
            const [reg, _plusplus, comment] = a.sequenceItems;
            return {
                kind: 'increment',
                register: parseRegister(reg.value),
                why: stripComment(comment.value),
            };
        }
        case 'identifier':
            return {
                kind: 'identifier',
            } as any;
        case 'loadImmediate':
            const [reg, _assign, imm, comment] = a.sequenceItems;
            return {
                kind: 'loadImmediate',
                destination: parseRegister(reg.value),
                value: imm.value,
                why: stripComment(comment.value),
            };
        case 'difference': {
            const [reg, _assign, lhs, _minus, rhs, comment] = a.sequenceItems;
            return {
                kind: 'subtract',
                destination: parseRegister(reg.value),
                lhs: parseRegister(lhs.value),
                rhs: parseRegister(rhs.value),
                why: stripComment(comment.value),
            };
        }
        case 'gotoIfNotEqual': {
            const [_goto, label, _if, lhs, _ne, rhsUnp, comment] = a.sequenceItems;
            const rhs = rhsUnp.type == 'number' ? rhsUnp.value : parseRegister(rhsUnp.value);
            return {
                kind: 'gotoIfNotEqual',
                label: label.value,
                lhs: parseRegister(lhs.value),
                rhs,
                why: stripComment(comment.value),
            };
        }
        case 'gotoIfGreater': {
            const [_goto, label, _if, lhs, _ge, rhs, comment] = a.sequenceItems;
            return {
                kind: 'gotoIfGreater',
                label: label.value,
                lhs: parseRegister(lhs.value),
                rhs: parseRegister(rhs.value),
                why: stripComment(comment.value),
            };
        }
        case 'store': {
            const [_star, to, _assign, from, comment] = a.sequenceItems;
            const why = stripComment(comment.value);
            if (from.type == 'number') {
                return {
                    kind: 'storeMemoryByte',
                    address: parseRegister(to.value),
                    contents: from.value,
                    why,
                };
            }
            if (!isRegister(to.value)) {
                return {
                    kind: 'storeGlobal',
                    from: parseRegister(from.value),
                    to: to.value,
                    why,
                };
            }
            return {
                kind: 'storeMemoryByte',
                address: parseRegister(to.value),
                contents: parseRegister(from.value),
                why,
            };
        }
        case 'offsetStore': {
            const [_star, _lb, to, _plus, offset, _rb, _assign, from, comment] = a.sequenceItems;
            if (from.value == 0) {
                return {
                    kind: 'storeZeroToMemory',
                    address: parseRegister(to.value),
                    offset: offset.value,
                    why: stripComment(comment.value),
                };
            }
            return {
                kind: 'storeMemory',
                address: parseRegister(to.value),
                offset: offset.value,
                from: parseRegister(from.value),
                why: stripComment(comment.value),
            };
        }
        case 'offsetLoad': {
            const [to, _assign, _star, _lb, from, _plus, offset, _rb, comment] = a.sequenceItems;
            return {
                kind: 'loadMemory',
                to: parseRegister(to.value),
                from: parseRegister(from.value),
                offset: offset.value,
                why: stripComment(comment.value),
            };
        }
        case 'addressOf': {
            const [to, _assign, _and, symbol, comment] = a.sequenceItems;
            return {
                kind: 'loadSymbolAddress',
                symbolName: symbol.value,
                to: parseRegister(to.value),
                why: stripComment(comment.value),
            };
        }
        case 'callByRegister': {
            const differentiator = a.sequenceItems[1];
            if (differentiator.type == 'assign') {
                const [to, _assign, from, _lb, args, _rb, comment] = a.sequenceItems;
                return {
                    kind: 'callByRegister',
                    function: parseRegister(from.value),
                    arguments: parseArgList(args),
                    destination: parseRegister(to.value),
                    why: stripComment(comment.value),
                };
            } else {
                if (differentiator.type != 'leftBracket') throw debug('expecting left bracket');
                const [from, _lb, args, _rb, comment] = a.sequenceItems;
                return {
                    kind: 'callByRegister',
                    function: parseRegister(from.value),
                    arguments: parseArgList(args),
                    destination: null,
                    why: stripComment(comment.value),
                };
            }
        }
        case 'callByName': {
            const differentiator = a.sequenceItems[1];
            if (differentiator.type == 'assign') {
                const [to, _assign, fn, _lb, args, _rb, comment] = a.sequenceItems;
                return {
                    kind: 'callByName',
                    function: fn.value,
                    arguments: parseArgList(args),
                    destination: parseRegister(to.value),
                    why: stripComment(comment.value),
                };
            } else {
                const [fn, _lb, args, _rb, comment] = a.sequenceItems;
                return {
                    kind: 'callByName',
                    function: fn.value,
                    arguments: parseArgList(args),
                    destination: null,
                    why: stripComment(comment.value),
                };
            }
        }
        case 'syscall': {
            if (a.sequenceItems[1].type == 'assign') {
                return {
                    kind: 'syscall',
                    name: a.sequenceItems[3].value,
                    arguments: parseSyscallArgs(a.sequenceItems[4].sequenceItems[0]),
                    destination: parseRegister(a.sequenceItems[0].value),
                    why: stripComment(a.sequenceItems[3].value),
                };
            } else {
                return {
                    kind: 'syscall',
                    name: a.sequenceItems[1].value,
                    arguments: parseSyscallArgs(a.sequenceItems[2].sequenceItems[0]),
                    destination: null,
                    why: stripComment(a.sequenceItems[3].value),
                };
            }
        }
        case 'plusEqual': {
            return {
                kind: 'addImmediate',
                register: parseRegister(a.sequenceItems[0].value),
                amount: a.sequenceItems[2].value,
                why: stripComment(a.sequenceItems[3].value),
            } as any;
        }
        case 'statementSeparator': {
            return {
                kind: 'empty',
                why: stripComment(a.sequenceItems[0].value),
            };
        }
        case 'product': {
            return {
                kind: 'multiply',
                destination: parseRegister(a.sequenceItems[0].value),
                lhs: parseRegister(a.sequenceItems[2].value),
                rhs: parseRegister(a.sequenceItems[4].value),
                why: stripComment(a.sequenceItems[5].value),
            };
        }
        case 'sum': {
            return {
                kind: 'add',
                destination: parseRegister(a.sequenceItems[0].value),
                lhs: parseRegister(a.sequenceItems[2].value),
                rhs: parseRegister(a.sequenceItems[4].value),
                why: stripComment(a.sequenceItems[5].value),
            };
        }
        case 'alloca':
            return {
                kind: 'alloca',
                register: parseRegister(a.sequenceItems[0].value),
                bytes: a.sequenceItems[4].value,
                why: stripComment(a.sequenceItems[6].value),
            };
        case 'spill':
            return {
                kind: ast.type as any,
                register: parseRegister(a.sequenceItems[1].value),
                offset: a.sequenceItems[0].value,
                why: stripComment(a.sequenceItems[2].value),
            };
        case 'unspill':
            if (Number.isNaN(a.sequenceItems[0].value)) debug('nan!');
            return {
                kind: ast.type as any,
                register: parseRegister(a.sequenceItems[1].value),
                offset: a.sequenceItems[0].value,
                why: stripComment(a.sequenceItems[2].value),
            };
        case 'return':
            if (a.sequenceItems.length < 2) debug('short in lengh');
            if (!a.sequenceItems || !a.sequenceItems[2]) debug('bad shape');
            return {
                kind: 'return',
                register: parseRegister(a.sequenceItems[1].value),
                why: stripComment(a.sequenceItems[2].value),
            };
        default:
            throw debug(`${ast.type} unhandled in instructionFromParseResult`);
    }
};

// TODO: This probably belongs in parser-lib
export type ParseError = string | ParseFailureInfo<TacToken>;

// TODO: this probably belongs in Statement
export const parseInstructions = (input: string): Statement[] | LexError | ParseError[] => {
    const result = parseString(tokenSpecs, grammar, 'instructions', input);
    if ('errors' in result) return result.errors;
    if (!isListNode(result)) throw debug('bad list');
    return result.items.map(instructionFromParseResult);
};

export const parseInstructionsOrDie = (tacString: string): Statement[] => {
    const parsed = parseInstructions(tacString);
    if ('kind' in parsed) {
        debugger;
        parseInstructions(tacString);
        throw debug(
            `error in parseInstructionsOrDie: ${parsed.kind}. ${JSON.stringify(parsed, null, 2)}`
        );
    }
    if (Array.isArray(parsed)) {
        if (parsed.length == 0) debug('empty instructions');
        const parsed0: any = parsed[0];
        if ('kind' in parsed0) {
            return parsed as Statement[];
        } else {
            throw debug(
                `error in parseInstructionsOrDie:\n${renderParseError(parsed0, tacString)}`
            );
        }
    }
    debugger;
    parseInstructions(tacString);
    throw debug(`error in parseInstructionsOrDie: not array`);
};
