import debug from '../util/debug.js';
import flatten from '../util/list/flatten.js';
import last from '../util/list/last.js';
import { TokenSpec, lex, LexError } from '../parser-lib/lex.js';
import { Register } from './Register.js';
import { Function } from './Function.js';
import { Program } from './Program.js';
import { Statement } from './statement.js';
import {
    Grammar,
    Sequence,
    OneOf,
    Terminal,
    Optional,
    parse,
    parseResultIsError,
    AstWithIndex,
    ParseFailureInfo,
    parseResultWithIndexIsSeparatedList,
} from '../parser-lib/parse.js';

type TacToken =
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
    {
        token: 'return',
        type: 'return',
        toString: x => x,
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
        token: 'syscall',
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
        token: '\\,',
        type: 'comma',
        toString: _ => ',',
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
        token: ';.*\n?',
        type: 'statementSeparator',
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

const grammar: Grammar<TacAstNode, TacToken> = {
    program: Sequence('program', [tacOptional('globals'), tacOptional('functions')]),

    globals: OneOf([Sequence('globals', ['global', 'globals']), 'global']),
    global: Sequence('global', [global_, identifier, colon, identifier, number]),

    functions: OneOf([Sequence('functions', ['function', 'functions']), 'function']),
    function: Sequence('function', [
        function_,
        tacOptional(spillSpec),
        identifier,
        leftBracket,
        tacOptional('argList'),
        rightBracket,
        colon,
        'instructions',
    ]),

    // TODO: make it possible to have function with no instructions
    instructions: OneOf([
        Sequence('instructions', ['instruction', 'instructions']),
        'instruction',
    ]),
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
            tacOptional('argList'),
            rightBracket,
            statementSeparator,
        ]),
        Sequence('callByName', [
            tacOptional(register),
            tacOptional(assign),
            identifier,
            leftBracket,
            tacOptional('argList'),
            rightBracket,
            statementSeparator,
        ]),
        Sequence('return', [return_, register, statementSeparator]),
    ]),

    argList: OneOf([Sequence('argList', ['arg', comma, 'argList']), 'arg']),
    arg: OneOf([number, register]),

    syscallArgs: OneOf([
        Sequence('syscallArgs', [tacOptional(identifier), 'syscallArg', 'syscallArgs']),
        'syscallArg',
    ]),
    syscallArg: OneOf([number, register]),

    data: OneOf([identifier, register, number]),
};

const mergeParseResults = (
    lhs: Program | ParseError[],
    rhs: Program | ParseError[]
): Program | ParseError[] => {
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
    if ((lhs as Program).main && (rhs as Program).main) {
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
    if (!ast) debug('no ast');
    if (parseResultWithIndexIsSeparatedList(ast)) {
        throw debug('todo');
    }
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

const parseArgList = (ast: AstWithIndex<TacAstNode, TacToken>): (Register | number)[] => {
    const a = ast as any;
    if (parseResultWithIndexIsSeparatedList(ast)) {
        throw debug('todo');
    }
    switch (ast.type) {
        case 'register':
            return [parseRegister(a.value)];
        case 'argList':
            return [...parseArgList(a.children[0]), ...parseArgList(a.children[2])];
        case 'number':
            return [a.value];
        default:
            return debug(`unhandled case in parseArgList: ${a.type}`);
    }
};

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
    if (!data.startsWith) debug('no startsWith');
    if (data.startsWith('r:')) {
        return new Register(data.substring(2));
    }
    throw debug('invalid register name');
};

const instructionFromParseResult = (ast: AstWithIndex<TacAstNode, TacToken>): Statement => {
    if (parseResultWithIndexIsSeparatedList(ast)) {
        throw debug('todo');
    }
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
            return {
                kind: 'label',
                name: a.children[0].value,
                why: stripComment(a.children[2].value),
            };
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
            if (a.children[5].type == 'number') {
                return {
                    kind: 'gotoIfEqual',
                    label: a.children[1].value,
                    lhs: parseRegister(a.children[3].value),
                    rhs: parseRegister(a.children[5].value),
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
            const rhs =
                a.children[5].type == 'number'
                    ? a.children[5].value
                    : parseRegister(a.children[5].value);
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
            return {
                kind: 'loadSymbolAddress',
                symbolName: a.children[3].value,
                to: parseRegister(a.children[0].value),
                why: stripComment(a.children[4].value),
            };
        }
        case 'callByRegister': {
            if (a.children[1].type == 'assign') {
                return {
                    kind: 'callByRegister',
                    function: parseRegister(a.children[2].value),
                    arguments: a.children.length == 7 ? parseArgList(a.children[4]) : [],
                    destination: parseRegister(a.children[0].value),
                    why: stripComment((last(a.children) as any).value),
                };
            } else {
                if (a.children[1].type != 'leftBracket') throw debug('expecting left bracket');
                return {
                    kind: 'callByRegister',
                    function: parseRegister(a.children[0].value),
                    arguments: a.children.length == 5 ? parseArgList(a.children[2]) : [],
                    destination: null,
                    why: stripComment((last(a.children) as any).value),
                };
            }
        }
        case 'callByName': {
            if (a.children[1].type == 'assign') {
                if (![6, 7].includes(a.children.length)) debug('wrong children lenght');
                return {
                    kind: 'callByName',
                    function: a.children[2].value,
                    arguments: a.children.length == 7 ? parseArgList(a.children[4]) : [],
                    destination: parseRegister(a.children[0].value),
                    why: stripComment((last(a.children) as any).value),
                };
            } else {
                if (![4, 5].includes(a.children.length)) debug('wrong children lenght');
                return {
                    kind: 'callByName',
                    function: a.children[0].value,
                    arguments: a.children.length == 5 ? parseArgList(a.children[2]) : [],
                    destination: null,
                    why: stripComment((last(a.children) as any).value),
                };
            }
        }
        case 'syscall': {
            if (a.children[1].type == 'assign') {
                return {
                    kind: 'syscall',
                    name: a.children[3].value,
                    arguments: parseSyscallArgs(a.children[4]),
                    destination: parseRegister(a.children[0].value),
                    why: stripComment(a.children[3].value),
                };
            } else {
                return {
                    kind: 'syscall',
                    name: a.children[1].value,
                    arguments: parseSyscallArgs(a.children[2]),
                    destination: null,
                    why: stripComment(a.children[3].value),
                };
            }
        }
        case 'plusEqual': {
            return {
                kind: 'addImmediate',
                register: parseRegister(a.children[0].value),
                amount: a.children[2].value,
                why: stripComment(a.children[3].value),
            } as any;
        }
        case 'statementSeparator': {
            return {
                kind: 'empty',
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
        case 'alloca':
            return {
                kind: 'alloca',
                register: parseRegister(a.children[0].value),
                bytes: a.children[4].value,
                why: stripComment(a.children[6].value),
            };
        case 'spill':
            return {
                kind: ast.type as any,
                register: parseRegister(a.children[1].value),
                offset: a.children[0].value,
                why: stripComment(a.children[2].value),
            };
        case 'unspill':
            if (Number.isNaN(a.children[0].value)) debug('nan!');
            return {
                kind: ast.type as any,
                register: parseRegister(a.children[1].value),
                offset: a.children[0].value,
                why: stripComment(a.children[2].value),
            };
        case 'return':
            if (a.children.length < 2) debug('short in lengh');
            if (!a.children || !a.children[2]) debug('bad shape');
            return {
                kind: 'return',
                register: parseRegister(a.children[1].value),
                why: stripComment(a.children[2].value),
            };
        default:
            throw debug(`${ast.type} unhandled in instructionFromParseResult`);
    }
};

const instructionsFromParseResult = (ast: AstWithIndex<TacAstNode, TacToken>): Statement[] => {
    if (parseResultWithIndexIsSeparatedList(ast)) {
        throw debug('todo');
    }
    if (ast.type == 'instructions') {
        const a = ast as any;
        return [
            instructionFromParseResult(a.children[0]),
            ...instructionsFromParseResult(a.children[1]),
        ];
    } else {
        const a = ast as any;
        return [instructionFromParseResult(a)];
    }
};

const functionFromParseResult = (
    ast: AstWithIndex<TacAstNode, TacToken>
): Function | ParseError[] => {
    if (parseResultWithIndexIsSeparatedList(ast)) {
        throw debug('todo');
    }
    if (ast.type != 'function') {
        return ['Need a function'];
    }
    if (!('children' in ast)) {
        debug('wrong shape ast');
        return ['WrongShapeAst'];
    }

    let childIndex = 0;
    let child = ast.children[childIndex];
    if (parseResultWithIndexIsSeparatedList(child)) {
        throw debug('todo');
    }
    if (child.type != 'function') {
        debug('wrong shape ast');
        return ['WrongShapeAst'];
    }
    childIndex++;
    child = ast.children[childIndex];
    if (parseResultWithIndexIsSeparatedList(child)) {
        throw debug('todo');
    }
    if (child.type == 'spillSpec') {
        childIndex++;
    }
    child = ast.children[childIndex];
    if (parseResultWithIndexIsSeparatedList(child)) {
        throw debug('todo');
    }
    if (child.type != 'identifier') {
        debug('wrong shape ast');
        return ['WrongShapeAst'];
    }
    const name = (ast.children[childIndex] as any).value;
    childIndex++;
    child = ast.children[childIndex];
    if (parseResultWithIndexIsSeparatedList(child)) {
        throw debug('todo');
    }
    if (child.type != 'leftBracket') {
        debug('wrong shape ast');
        return ['WrongShapeAst'];
    }
    childIndex++;
    let args: Register[] = [];
    child = ast.children[childIndex];
    if (parseResultWithIndexIsSeparatedList(child)) {
        throw debug('todo');
    }
    if (['argList', 'register'].includes(child.type)) {
        const numArgs = parseArgList(ast.children[childIndex]);
        numArgs.forEach(a => {
            if (typeof a == 'number') {
                debug("arg can't be a number");
            }
        });
        args = numArgs as Register[];
        childIndex++;
    }

    child = ast.children[childIndex];
    if (parseResultWithIndexIsSeparatedList(child)) {
        throw debug('todo');
    }
    if (child.type != 'rightBracket') {
        debug('wrong shape ast');
        return ['WrongShapeAst'];
    }
    childIndex++;
    child = ast.children[childIndex];
    if (parseResultWithIndexIsSeparatedList(child)) {
        throw debug('todo');
    }
    if (child.type != 'colon') {
        debug('wrong shape ast');
        return ['WrongShapeAst'];
    }
    childIndex++;
    let instructions: Statement[] = [];
    child = ast.children[childIndex];
    if (parseResultWithIndexIsSeparatedList(child)) {
        throw debug('todo');
    }
    if (child.type == 'instructions') {
        instructions = instructionsFromParseResult(ast.children[childIndex]);
        childIndex++;
    } else {
        instructions = [instructionFromParseResult(ast.children[childIndex])];
        childIndex++;
    }
    return { name, instructions, liveAtExit: [], arguments: args };
};

// TODO: this should accept Ast, not AstWithIndex
const tacFromParseResult = (ast: AstWithIndex<TacAstNode, TacToken>): Program | ParseError[] => {
    if (!ast) debug('no type');
    if (parseResultWithIndexIsSeparatedList(ast)) {
        throw debug('todo');
    }
    switch (ast.type) {
        case 'program':
            return ast.children.reduce(
                (results, child) => mergeParseResults(results, tacFromParseResult(child)),
                {
                    globals: {},
                    functions: [],
                    main: undefined,
                    stringLiterals: [],
                }
            );
        case 'global': {
            const a = ast as any;
            return {
                globals: {
                    [a.children[1].value]: {
                        mangledName: a.children[3].value,
                        bytes: a.children[4].value,
                    },
                },
                functions: [],
                main: undefined,
                stringLiterals: [],
            };
        }
        case 'globals': {
            return mergeParseResults(
                tacFromParseResult(ast.children[0]),
                tacFromParseResult(ast.children[1])
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
                    main: f.name == 'main' ? f : undefined,
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
                main: f.name == 'main' ? f : undefined,
                stringLiterals: [],
            };
        }
        default:
            throw debug(`${ast.type} unhandled in tacFromParseResult`);
    }
};

type ParseError = string | ParseFailureInfo<TacToken>;

export const parseProgram = (input: string): Program | LexError | ParseError[] => {
    const tokens = lex(tokenSpecs, input);
    if ('kind' in tokens) {
        return tokens;
    }
    const parseResult = parse(grammar, 'program', tokens);
    if (parseResultIsError(parseResult)) {
        return parseResult.errors;
    }
    return tacFromParseResult(parseResult);
};

export const parseFunction = (input: string): Function | LexError | ParseError[] => {
    const tokens = lex(tokenSpecs, input);
    if ('kind' in tokens) {
        return tokens;
    }
    const parseResult = parse(grammar, 'function', tokens);
    if (parseResultIsError(parseResult)) {
        return parseResult.errors;
    }
    return functionFromParseResult(parseResult);
};

export const parseFunctionOrDie = (tacString: string): Function => {
    const parsed = parseFunction(tacString);
    if ('kind' in parsed) {
        debugger;
        parseFunction(tacString);
        throw debug('error in parseFunctionOrDie');
    }
    if (Array.isArray(parsed)) {
        debugger;
        parseFunction(tacString);
        throw debug('error in parseFunctionOrDie');
    }
    return parsed;
};

export const parseInstructions = (input: string): Statement[] | LexError | ParseError[] => {
    const tokens = lex(tokenSpecs, input);
    if ('kind' in tokens) {
        return tokens;
    }
    const parseResult = parse(grammar, 'instructions', tokens);
    if (parseResultIsError(parseResult)) {
        return parseResult.errors;
    }
    return instructionsFromParseResult(parseResult);
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
        }
    }
    debugger;
    parseInstructions(tacString);
    throw debug('error in parseInstructionsOrDie: not array');
};
