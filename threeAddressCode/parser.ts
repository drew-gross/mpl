import debug from '../util/debug.js';
import { TokenSpec, lex } from '../parser-lib/lex.js';
import { specialRegisterNames, Register } from '../register.js';
import { ThreeAddressProgram, ThreeAddressCode, ThreeAddressStatement } from './generator.js';
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
    | 'register'
    | 'star'
    | 'plusplus'
    | 'lessThan'
    | 'greaterThan'
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
        token: 'goto',
        type: 'goto',
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
        token: '#.*\n',
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
    | 'global'
    | 'loadImmediate'
    | 'globals'
    | 'label'
    | 'function'
    | 'functions'
    | 'instructions'
    | 'gotoIfEqual'
    | 'instruction'
    | 'callByName'
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
const comment = tacTerminal('comment');
const assign = tacTerminal('assign');
const star = tacTerminal('star');
const goto = tacTerminal('goto');
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
    program: OneOf<TacAstNode, TacToken>(['global', 'function', endOfInput]),
    global: Sequence('global', [global_, identifier, colon, identifier, number, 'program']),
    function: Sequence('function', [function_, identifier, colon, 'instructions', 'program']),
    instructions: OneOf([Sequence('instructions', ['instruction', 'instructions']), 'instruction']),
    instruction: OneOf([
        Sequence('comment', [comment]),
        Sequence('label', [identifier, colon, comment]),
        Sequence('syscall', [syscall, comment]),
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
        Sequence('callByRegister', [register, leftBracket, rightBracket, comment]),
        Sequence('callByName', [identifier, leftBracket, rightBracket, comment]),
    ]),
    data: OneOf([identifier, register, number]),
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

    return {
        globals: { ...(lhs as any).globals, ...(rhs as any).globals },
        functions: [...(lhs as any).functions, ...(rhs as any).functions],
    };
};

const stripComment = (str: string): string => {
    return str.substring(2, str.length - 1);
};

const parseRegister = (data: string): Register => {
    if (!data) debug('no data');
    const sliced = data.substring(2, data.length);
    if (specialRegisterNames.includes(sliced)) {
        return sliced as Register;
    }
    return { name: sliced };
};

const parseInstruction = (ast: AstWithIndex<TacAstNode, TacToken>): ThreeAddressStatement => {
    const a = ast as any;
    switch (ast.type) {
        case 'assign':
            return {
                kind: 'move',
                to: a.children[0].value,
                from: parseRegister(a.children[2].value) as any,
                why: stripComment(a.children[3].value),
            };
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
            return {
                kind: 'gotoIfEqual',
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
                function: { name: a.children[0].value },
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

const tacFromParseResult = (ast: AstWithIndex<TacAstNode, TacToken>): ThreeAddressProgram | ParseError[] => {
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
                },
                tacFromParseResult(a.children[5])
            );
        }
        case 'function': {
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
            const remainder = tacFromParseResult(ast.children[4]);
            return mergeParseResults(
                {
                    globals: {},
                    functions: [{ isMain: false, name, instructions }],
                },
                remainder
            );
        }
        case 'endOfFile': {
            return { globals: {}, functions: [] };
        }
        default:
            throw debug(`${ast.type} unhandled in tacFromParseResult`);
    }
};

type ParseError = string | ParseFailureInfo<TacToken>;

export default (input: string): ThreeAddressProgram | ParseError[] => {
    const tokens = lex(tokenSpecs, input);
    1;
    if (tokens.some(t => t.type == 'invalid')) {
        const t = tokens.find(t => t.type == 'invalid');
        if (t) return [`found an invalid token: ${t.string}`];
        return ['unknown invalid token'];
    }
    const parseResult = parse(grammar, 'program', tokens, 0);
    if (parseResultIsError(parseResult)) {
        return parseResult.errors;
    }
    return tacFromParseResult(parseResult);
};
