import debug from '../util/debug.js';
import { TokenSpec, lex } from '../lex.js';
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
} from '../parser-combinator.js';

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
    | 'notequal'
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
        type: 'notequal',
        toString: _ => '!=',
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
const plusplus = tacTerminal('plusplus');
const minus = tacTerminal('minus');

const grammar: Grammar<TacAstNode, TacToken> = {
    program: OneOf<TacAstNode, TacToken>(['globals', 'functions', endOfInput]),
    globals: Sequence('globals', ['global', 'program']),
    global: Sequence('global', [global_, identifier, colon, identifier, number]),
    functions: Sequence('functions', ['function', 'program']),
    function: Sequence('function', [function_, identifier, colon, 'instructions']),
    instructions: Sequence('instructions', ['instruction', 'instructions']),
    instruction: OneOf([
        Sequence('comment', [comment]),
        Sequence('label', [identifier, colon, comment]),
        Sequence('constAssign', [identifier, assignment, number, comment]),
        Sequence('derefAssign', [identifier, assignment, star, identifier, comment]),
        Sequence('differenceAssign', [identifier, assignment, identifier, minus, identifier, comment]),
        Sequence('gotoIfEqual', [goto, identifier, if_, identifier, doubleEqual, number, comment]),
        Sequence('goto', [goto, identifier, comment]),
        Sequence('increment', [identifier, plusplus, comment]),
    ]),
};

const tacFromParseResult = (ast: AstWithIndex<TacAstNode, TacToken>): ThreeAddressProgram | ParseError[] => {
    switch (ast.type) {
        case 'program':
            if (ast.children[0].type != 'global') return ['WrongShapeAst'];
            if (ast.children[1].type != 'colon') return ['WrongShapeAst'];
            return tacFromParseResult(ast.children[2]);
        case 'global':
            const a = ast as any;
            return {
                globals: { [a.children[1].value]: { mangledName: a.children[3].value, bytes: a.children[4].value } },
                functions: [],
            };
        default:
            throw debug(`${ast.type} unhandled in tacFromParseResult`);
    }
};

type ParseError = string;

export default (input: string): ThreeAddressProgram | ParseError[] => {
    const tokens = lex(tokenSpecs, input);
    if (tokens.some(t => t.type == 'invalid')) {
        const t = tokens.find(t => t.type == 'invalid');
        if (t) return [`found an invalid token: ${t.string}`];
        return ['unknown invalid token'];
    }
    debugger;
    const parseResult = parse(grammar, 'program', tokens, 0);
    if (parseResultIsError(parseResult)) {
        return [`unabled to parse: ${JSON.stringify(parseResult, null, 4)}`];
    }
    return tacFromParseResult(parseResult);
};
