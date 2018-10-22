import debug from '../util/debug.js';
import { TokenSpec, lex } from '../parser-lib/lex.js';
import { ThreeAddressProgram } from './generator.js';
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
    | 'assignment'
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
        token: '\\d+',
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
        type: 'assignment',
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
    | 'globals'
    | 'function'
    | 'functions'
    | 'instructions'
    | 'instruction'
    | 'comment';

const tacTerminal = token => Terminal<TacAstNode, TacToken>(token);
const tacOptional = parser => Optional<TacAstNode, TacToken>(parser);

const identifier = tacTerminal('identifier');
const leftBracket = tacTerminal('leftBracket');
const rightBracket = tacTerminal('rightBracket');
const number = tacTerminal('number');
const colon = tacTerminal('colon');
const global_ = tacTerminal('global');
const function_ = tacTerminal('function');
const comment = tacTerminal('comment');
const assignment = tacTerminal('assignment');
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
        Sequence('assign', [identifier, assignment, 'idOrNumber', comment]),
        Sequence('load', [identifier, assignment, star, identifier, comment]),
        Sequence('store', [star, identifier, assignment, 'idOrNumber', comment]),
        Sequence('offsetStore', [
            star,
            leftBracket,
            identifier,
            plus,
            number,
            rightBracket,
            assignment,
            identifier,
            comment,
        ]),
        Sequence('offsetLoad', [
            identifier,
            assignment,
            star,
            leftBracket,
            identifier,
            plus,
            number,
            rightBracket,
            comment,
        ]),
        Sequence('difference', [identifier, assignment, identifier, minus, identifier, comment]),
        Sequence('product', [identifier, assignment, identifier, star, identifier, comment]),
        Sequence('sum', [identifier, assignment, identifier, plus, identifier, comment]),
        Sequence('addressOf', [identifier, assignment, and, identifier, comment]),
        Sequence('gotoIfEqual', [goto, identifier, if_, identifier, doubleEqual, 'idOrNumber', comment]),
        Sequence('gotoIfNotEqual', [goto, identifier, if_, identifier, notEqual, 'idOrNumber', comment]),
        Sequence('gotoIfGreater', [goto, identifier, if_, identifier, greaterThan, identifier, comment]),
        Sequence('plusEqual', [identifier, plusEqual, 'idOrNumber', comment]),
        Sequence('goto', [goto, identifier, comment]),
        Sequence('increment', [identifier, plusplus, comment]),
        Sequence('call', [identifier, leftBracket, rightBracket, comment]),
    ]),
    idOrNumber: OneOf([identifier, Sequence('number', [tacOptional(minus), number])]),
};

const mergeParseReuslts = (lhs, rhs) => ({
    globals: { ...lhs.globals, ...rhs.globals },
    functions: [...lhs.functions, ...rhs.functions],
});

const tacFromParseResult = (ast: AstWithIndex<TacAstNode, TacToken>): ThreeAddressProgram | ParseError[] => {
    switch (ast.type) {
        case 'program':
            if (ast.children[0].type != 'global') return ['WrongShapeAst'];
            if (ast.children[1].type != 'colon') return ['WrongShapeAst'];
            return tacFromParseResult(ast.children[2]);
        case 'global': {
            const a = ast as any;
            return mergeParseReuslts(
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
            if (!('children' in ast)) return ['WrongShapeAst'];
            if (ast.children[0].type != 'function') return ['WrongShapeAst'];
            if (ast.children[1].type != 'identifier') return ['WrongShapeAst'];
            const name = (ast.children[1] as any).value;
            if (ast.children[2].type != 'colon') return ['WrongShapeAst'];
            if (ast.children[3].type != 'instructions') return ['WrongShapeAst'];
            const instructions = tacFromParseResult(ast.children[3]);
            const remainder = tacFromParseResult(ast.children[4]);
            return mergeParseReuslts(
                {
                    globals: {},
                    functions: [{ isMain: false, name, instructions }],
                },
                remainder
            );
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
