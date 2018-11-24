import debug from '../util/debug.js';
import flatten from '../util/list/flatten.js';
import { TokenSpec, lex } from '../parser-lib/lex.js';
import { specialRegisterNames, Register } from '../register.js';
import { ThreeAddressProgram, ThreeAddressCode, ThreeAddressStatement, ThreeAddressFunction } from './generator.js';
import {
    Grammar,
    Sequence,
    OneOf,
    Terminal,
    endOfInput,
    Optional,
    parse,
    parseResultIsError,
    AstWithIndex,
    ParseFailureInfo,
} from '../parser-lib/parse.js';

type TacToken =
    | 'global'
    | 'function'
    | 'goto'
    | 'if'
    | 'doubleEqual'
    | 'colon'
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
    | 'comment'
    | 'invalid';

const tokenSpecs: TokenSpec<TacToken>[] = [
    {
        token: '\\(global\\)',
        type: 'global',
        toString: x => x,
    },
    {
        token: '\\(function\\)',
        type: 'function',
        toString: x => x,
    },
    {
        token: '\\(spill:\\d+\\)',
        type: 'spillSpec',
        toString: x => x,
        action: s => parseInt(s.slice(7, -1), 10),
    },
    {
        token: 'goto',
        type: 'goto',
        toString: x => x,
    },
    {
        token: 'alloca',
        type: 'alloca',
        toString: x => x,
    },
    {
        token: 'r:[a-z]\\w*',
        type: 'register',
        toString: x => x,
        action: x => x,
    },
    {
        token: 'syscalld?',
        type: 'syscall',
        toString: x => x,
        action: x => x,
    },
    {
        token: 'if',
        type: 'if',
        toString: x => x,
    },
    {
        token: '\\:',
        type: 'colon',
        toString: _ => ':',
    },
    {
        token: '-?\\d+',
        type: 'number',
        action: parseInt,
        toString: x => x.toString(),
    },
    {
        token: '!=',
        type: 'notEqual',
        toString: _ => '!=',
    },
    {
        token: '\\+=',
        type: 'plusEqual',
        toString: _ => '+=',
    },
    {
        token: '==',
        type: 'doubleEqual',
        toString: _ => '==',
    },
    {
        token: '\\+\\+',
        type: 'plusplus',
        toString: _ => '++',
    },
    {
        token: '\\+',
        type: 'plus',
        toString: _ => '+',
    },
    {
        token: '\\(',
        type: 'leftBracket',
        toString: _ => '(',
    },
    {
        token: '\\)',
        type: 'rightBracket',
        toString: _ => ')',
    },
    {
        token: '=',
        type: 'assign',
        toString: () => '=',
    },
    {
        token: '\\*',
        type: 'star',
        toString: _ => '*',
    },
    {
        token: '\\&',
        type: 'and',
        toString: _ => '*',
    },
    {
        token: '\\-',
        type: 'minus',
        toString: _ => '-',
    },
    {
        token: '<',
        type: 'lessThan',
        toString: _ => '<',
    },
    {
        token: '>',
        type: 'greaterThan',
        toString: _ => '>',
    },
    {
        token: '[a-z]\\w*',
        type: 'identifier',
        action: x => x,
        toString: x => x,
    },
    {
        token: '#.*\n?',
        type: 'comment',
        action: x => x,
        toString: x => x,
    },
    {
        token: '.*',
        type: 'invalid',
        action: x => x,
        toString: x => x,
    },
];

type TacAstNode =
    | 'program'
    | 'addressOf'
    | 'global'
    | 'loadImmediate'
    | 'globals'
    | 'label'
    | 'function'
    | 'functions'
    | 'instructions'
    | 'sum'
    | 'difference'
    | 'gotoIfEqual'
    | 'gotoIfNotEqual'
    | 'gotoIfGreater'
    | 'instruction'
    | 'store'
    | 'syscallArgs'
    | 'offsetStore'
    | 'offsetLoad'
    | 'callByName'
    | 'stackAllocateAndStorePointer'
    | 'product'
    | 'callByRegister'
    | 'load'
    | 'increment'
    | 'comment';

const tacTerminal = token => Terminal<TacAstNode, TacToken>(token);
const tacOptional = parser => Optional<TacAstNode, TacToken>(parser);

const identifier = tacTerminal('identifier');
const leftBracket = tacTerminal('leftBracket');
const rightBracket = tacTerminal('rightBracket');
const number = tacTerminal('number');
const register = tacTerminal('register');
const colon = tacTerminal('colon');
const global_ = tacTerminal('global');
const function_ = tacTerminal('function');
const spillSpec = tacTerminal('spillSpec');
const comment = tacTerminal('comment');
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
const greaterThan = tacTerminal('greaterThan');

const grammar: Grammar<TacAstNode, TacToken> = {
    program: OneOf<TacAstNode, TacToken>(['global', 'functions', endOfInput]),
    global: Sequence('global', [global_, identifier, colon, identifier, number, 'program']),
    functions: OneOf([Sequence('functions', ['function', 'functions']), 'function']),
    function: Sequence('function', [function_, tacOptional(spillSpec), identifier, colon, 'instructions']),
    instructions: OneOf([Sequence('instructions', ['instruction', 'instructions']), 'instruction']),
    instruction: OneOf([
        Sequence('comment', [comment]),
        Sequence('label', [identifier, colon, comment]),
        // TODO: probably need separate syntax for syscall with result
        Sequence('syscall', [syscall, identifier, 'syscallArgs', comment]),
        Sequence('loadImmediate', [register, assign, number, comment]),
        Sequence('assign', [register, assign, 'data', comment]),
        Sequence('load', [register, assign, star, 'data', comment]),
        Sequence('store', [star, 'data', assign, 'data', comment]),
        Sequence('offsetStore', [star, leftBracket, register, plus, number, rightBracket, assign, 'data', comment]),
        Sequence('offsetLoad', [register, assign, star, leftBracket, register, plus, number, rightBracket, comment]),
        Sequence('difference', [register, assign, 'data', minus, 'data', comment]),
        Sequence('product', [register, assign, 'data', star, 'data', comment]),
        Sequence('sum', [register, assign, 'data', plus, 'data', comment]),
        Sequence('addressOf', [register, assign, and, 'data', comment]),
        Sequence('gotoIfEqual', [goto, identifier, if_, 'data', doubleEqual, 'data', comment]),
        Sequence('gotoIfNotEqual', [goto, identifier, if_, 'data', notEqual, 'data', comment]),
        Sequence('gotoIfGreater', [goto, identifier, if_, 'data', greaterThan, 'data', comment]),
        Sequence('plusEqual', [register, plusEqual, 'data', comment]),
        Sequence('goto', [goto, identifier, comment]),
        Sequence('increment', [register, plusplus, comment]),
        Sequence('stackAllocateAndStorePointer', [
            register,
            assign,
            alloca,
            leftBracket,
            number,
            rightBracket,
            comment,
        ]),
        Sequence('callByRegister', [register, leftBracket, rightBracket, comment]),
        Sequence('callByName', [identifier, leftBracket, rightBracket, comment]),
    ]),
    data: OneOf([identifier, register, number]),
    syscallArgs: OneOf([Sequence('syscallArgs', [tacOptional(identifier), 'syscallArg', 'syscallArgs']), 'syscallArg']),
    syscallArg: OneOf([number, register]),
};

const mergeParseResults = (
    lhs: ThreeAddressProgram | ParseError[],
    rhs: ThreeAddressProgram | ParseError[]
): ThreeAddressProgram | ParseError[] => {
    let errors: ParseError[] = [];
    if (Array.isArray(lhs)) {
        errors = errors.concat(lhs);
    }
    if (Array.isArray(rhs)) {
        errors = errors.concat(rhs);
    }
    if (errors.length > 0) {
        return errors;
    }
    if ((lhs as ThreeAddressProgram).main && (rhs as ThreeAddressProgram).main) {
        return ['both functions had a main!'];
    }

    return {
        globals: { ...(lhs as any).globals, ...(rhs as any).globals },
        functions: [...(lhs as any).functions, ...(rhs as any).functions],
        main: (lhs as any).main || (rhs as any).main,
        stringLiterals: [...(lhs as any).stringLiterals, ...(rhs as any).stringLiterals],
    };
};

const parseSyscallArgs = (ast: AstWithIndex<TacAstNode, TacToken>): (Register | number)[] => {
    const a = ast as any;
    switch (ast.type) {
        case 'register':
            return [parseRegister(a.value)];
        case 'number':
            return [a.value];
        case 'syscallArgs':
            return flatten(a.children.map(parseSyscallArgs));
        default:
            return debug(`unhandled case in parseSyscallArgs: ${a.type}`);
    }
};

const stripComment = (str: string): string => {
    return str.substring(2, str.length - 1);
};

const isRegister = (data: string): boolean => {
    if (specialRegisterNames.includes(data)) {
        return true;
    }
    if (data.startsWith('r:')) {
        return true;
    }
    return false;
};

const parseRegister = (data: string): Register => {
    if (!data) debug('no data');
    if (!isRegister(data)) debug('not register');
    const sliced = data.substring(2, data.length);
    if (specialRegisterNames.includes(sliced)) {
        return sliced as Register;
    }
    return { name: sliced };
};

const parseInstruction = (ast: AstWithIndex<TacAstNode, TacToken>): ThreeAddressStatement => {
    const a = ast as any;
    switch (ast.type) {
        case 'assign': {
            const to = parseRegister(a.children[0].value);
            const from = a.children[2].value;
            const why = stripComment(a.children[3].value);
            if (isRegister(from)) {
                return { kind: 'move', to, from: parseRegister(from), why };
            } else {
                return { kind: 'loadGlobal', from, to, why };
            }
        }
        case 'label':
            return { kind: 'label', name: a.children[0].value, why: stripComment(a.children[2].value) };
        case 'load':
            return {
                kind: 'loadMemoryByte',
                address: parseRegister(a.children[3].value),
                to: parseRegister(a.children[0].value),
                why: stripComment(a.children[4].value),
            };
        case 'goto':
            if (a.children.length == 3) {
                return {
                    kind: 'goto',
                    label: a.children[1].value,
                    why: stripComment(a.children[2].value),
                };
            }
            return {
                kind: 'goto',
            } as any;
        case 'gotoIfEqual': {
            if (a.children[5].value == 0) {
                return {
                    kind: 'gotoIfZero',
                    label: a.children[1].value,
                    register: parseRegister(a.children[3].value),
                    why: stripComment(a.children[6].value),
                };
            }
            return {
                kind: 'gotoIfEqual',
                label: a.children[1].value,
                lhs: parseRegister(a.children[3].value),
                rhs: parseRegister(a.children[5].value),
                why: stripComment(a.children[6].value),
            } as any;
        }
        case 'increment':
            return {
                kind: 'increment',
                register: parseRegister(a.children[0].value),
                why: stripComment(a.children[2].value),
            };
        case 'identifier':
            return {
                kind: 'identifier',
            } as any;
        case 'loadImmediate':
            return {
                kind: 'loadImmediate',
                destination: parseRegister(a.children[0].value),
                value: a.children[2].value,
                why: stripComment(a.children[3].value),
            };
        case 'callByRegister': {
            return {
                kind: 'callByRegister',
                function: parseRegister(a.children[0].value),
                why: stripComment(a.children[3].value),
            };
        }
        case 'callByName': {
            return {
                kind: 'callByName',
                function: a.children[0].value,
                why: stripComment(a.children[3].value),
            };
        }
        case 'difference': {
            return {
                kind: 'subtract',
                destination: parseRegister(a.children[0].value),
                lhs: parseRegister(a.children[2].value),
                rhs: parseRegister(a.children[4].value),
                why: stripComment(a.children[5].value),
            };
        }
        case 'gotoIfNotEqual': {
            const rhs = a.children[5].type == 'number' ? a.children[5].value : parseRegister(a.children[5].value);
            return {
                kind: 'gotoIfNotEqual',
                label: a.children[1].value,
                lhs: parseRegister(a.children[3].value),
                rhs,
                why: stripComment(a.children[6].value),
            };
        }
        case 'gotoIfGreater': {
            return {
                kind: 'gotoIfGreater',
                label: a.children[1].value,
                lhs: parseRegister(a.children[3].value),
                rhs: parseRegister(a.children[5].value),
                why: stripComment(a.children[6].value),
            };
        }
        case 'store': {
            const why = stripComment(a.children[4].value);
            if (a.children[3].type == 'number') {
                return {
                    kind: 'storeMemoryByte',
                    address: parseRegister(a.children[1].value),
                    contents: a.children[3].value,
                    why,
                };
            }
            if (!isRegister(a.children[1].value)) {
                return {
                    kind: 'storeGlobal',
                    from: parseRegister(a.children[3].value),
                    to: a.children[1].value,
                    why,
                };
            }
            return {
                kind: 'storeMemoryByte',
                address: parseRegister(a.children[1].value),
                contents: parseRegister(a.children[3].value),
                why,
            };
        }
        case 'offsetStore': {
            if (a.children[7].value == 0) {
                return {
                    kind: 'storeZeroToMemory',
                    address: parseRegister(a.children[2].value),
                    offset: a.children[4].value,
                    why: stripComment(a.children[8].value),
                };
            }
            return {
                kind: 'storeMemory',
                address: parseRegister(a.children[2].value),
                offset: a.children[4].value,
                from: parseRegister(a.children[7].value),
                why: stripComment(a.children[8].value),
            };
        }
        case 'offsetLoad': {
            return {
                kind: 'loadMemory',
                to: parseRegister(a.children[0].value),
                from: parseRegister(a.children[4].value),
                offset: a.children[6].value,
                why: stripComment(a.children[8].value),
            };
        }
        case 'addressOf': {
            if (stripComment(a.children[4].value) == 'Load first block so we can write to it if necessary') debugger;
            return {
                kind: 'loadSymbolAddress',
                symbolName: a.children[3].value,
                to: parseRegister(a.children[0].value),
                why: stripComment(a.children[4].value),
            };
        }
        case 'syscall': {
            const name = a.children[1].value;
            let args = parseSyscallArgs(a.children[2]);
            let destination = undefined;
            if (a.children[0].value == 'syscalld') {
                if (typeof args[0] == 'number') {
                    throw debug('invlaid destination');
                }
                destination = args[0] as any;
                args = args.slice(1);
            }
            return { kind: 'syscall', name, destination, arguments: args, why: stripComment(a.children[3].value) };
        }
        case 'plusEqual': {
            return {
                kind: 'addImmediate',
                register: parseRegister(a.children[0].value),
                amount: a.children[2].value,
                why: stripComment(a.children[3].value),
            } as any;
        }
        case 'comment': {
            return {
                kind: 'comment',
                why: stripComment(a.children[0].value),
            };
        }
        case 'product': {
            return {
                kind: 'multiply',
                destination: parseRegister(a.children[0].value),
                lhs: parseRegister(a.children[2].value),
                rhs: parseRegister(a.children[4].value),
                why: stripComment(a.children[5].value),
            };
        }
        case 'sum': {
            return {
                kind: 'add',
                destination: parseRegister(a.children[0].value),
                lhs: parseRegister(a.children[2].value),
                rhs: parseRegister(a.children[4].value),
                why: stripComment(a.children[5].value),
            };
        }
        case 'stackAllocateAndStorePointer':
            return {
                kind: 'stackAllocateAndStorePointer',
                register: parseRegister(a.children[0].value),
                bytes: a.children[4].value,
                why: stripComment(a.children[6].value),
            };
        default:
            return {
                kind: ast.type,
            } as any;
    }
};

const parseInstructions = (ast: AstWithIndex<TacAstNode, TacToken>): ThreeAddressCode => {
    if (ast.type == 'instructions') {
        const a = ast as any;
        return [parseInstruction(a.children[0]), ...parseInstructions(a.children[1])];
    } else {
        const a = ast as any;
        return [parseInstruction(a)];
    }
};

const functionFromParseResult = (ast: AstWithIndex<TacAstNode, TacToken>): ThreeAddressFunction | ParseError[] => {
    if (ast.type != 'function') {
        return ['Need a function'];
    }

    if (!('children' in ast)) {
        debug('wrong shape ast');
        return ['WrongShapeAst'];
    }
    if (ast.children[0].type != 'function') {
        debug('wrong shape ast');
        return ['WrongShapeAst'];
    }
    if (ast.children[1].type != 'identifier') {
        debug('wrong shape ast');
        return ['WrongShapeAst'];
    }
    const name = (ast.children[1] as any).value;
    if (ast.children[2].type != 'colon') {
        debug('wrong shape ast');
        return ['WrongShapeAst'];
    }
    let instructions: ThreeAddressCode = [];
    if (ast.children[3].type == 'instructions') {
        instructions = parseInstructions(ast.children[3]);
    } else if (ast.children[3].type == 'syscall') {
        instructions = [parseInstruction(ast.children[3])];
    }
    return { name, instructions };
};

const tacFromParseResult = (ast: AstWithIndex<TacAstNode, TacToken>): ThreeAddressProgram | ParseError[] => {
    if (!ast) debug('no type');
    switch (ast.type) {
        case 'program':
            if (ast.children[0].type != 'global') {
                debug('wrong shape ast');
                return ['WrongShapeAst'];
            }
            if (ast.children[1].type != 'colon') {
                debug('wrong shape ast');
                return ['WrongShapeAst'];
            }
            return tacFromParseResult(ast.children[2]);
        case 'global': {
            const a = ast as any;
            return mergeParseResults(
                {
                    globals: {
                        [a.children[1].value]: { mangledName: a.children[3].value, bytes: a.children[4].value },
                    },
                    functions: [],
                    main: undefined,
                    stringLiterals: [],
                },
                tacFromParseResult(a.children[5])
            );
        }
        case 'functions': {
            const f = functionFromParseResult(ast.children[0]);
            if (Array.isArray(f)) {
                return f;
            }
            const remainder = tacFromParseResult(ast.children[1]);
            return mergeParseResults(
                {
                    globals: {},
                    functions: f.name == 'main' ? [] : [f],
                    main: f.name == 'main' ? f.instructions : undefined,
                    stringLiterals: [],
                },
                remainder
            );
        }
        case 'function': {
            const f = functionFromParseResult(ast);
            if (Array.isArray(f)) {
                return f;
            }
            return {
                globals: {},
                functions: f.name == 'main' ? [] : [f],
                main: f.name == 'main' ? f.instructions : undefined,
                stringLiterals: [],
            };
        }
        case 'endOfFile': {
            return { globals: {}, functions: [], stringLiterals: [], main: undefined };
        }
        default:
            throw debug(`${ast.type} unhandled in tacFromParseResult`);
    }
};

type ParseError = string | ParseFailureInfo<TacToken>;

export const parseProgram = (input: string): ThreeAddressProgram | ParseError[] => {
    const tokens = lex(tokenSpecs, input);
    if (tokens.some(t => t.type == 'invalid')) {
        const t = tokens.find(t2 => t2.type == 'invalid');
        if (t) return [`found an invalid token: ${t.string}`];
        return ['unknown invalid token'];
    }
    const parseResult = parse(grammar, 'program', tokens, 0);
    if (parseResultIsError(parseResult)) {
        return parseResult.errors;
    }
    return tacFromParseResult(parseResult);
};

export const parseFunction = (input: string): ThreeAddressFunction | ParseError[] => {
    const tokens = lex(tokenSpecs, input);
    if (tokens.some(t => t.type == 'invalid')) {
        const t = tokens.find(t2 => t2.type == 'invalid');
        if (t) return [`found an invalid token: ${t.string}`];
        return ['unknown invalid token'];
    }
    const parseResult = parse(grammar, 'function', tokens, 0);
    if (parseResultIsError(parseResult)) {
        return parseResult.errors;
    }
    return functionFromParseResult(parseResult);
};
