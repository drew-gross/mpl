import debug from '../util/debug.js';
import { TokenSpec, lex } from '../lex.js';
import { ThreeAddressProgram } from './generator.js';
import {
    Grammar,
    Sequence,
    OneOf,
    terminal,
    Optional,
    parse,
    parseResultIsError,
    AstWithIndex,
} from '../parser-combinator.js';

type TacToken =
    | 'global'
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
        type: 'global',
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

type TacAstNode = 'program' | 'global' | 'globalList';

const tacTerminal = token => terminal<TacAstNode, TacToken>(token);
const tacOptional = parser => Optional<TacAstNode, TacToken>(parser);

const identifier = tacTerminal('identifier');
const number = tacTerminal('number');
const colon = tacTerminal('colon');
const globals = tacTerminal('globals');

const grammar: Grammar<TacAstNode, TacToken> = {
    program: Sequence('program', [globals, colon, 'globalList']),
    globalList: OneOf([Sequence('globalList', ['global', 'globalList']), 'global']),
    global: Sequence('global', [identifier, colon, identifier, number]),
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
                globals: { [a.children[0].value]: { mangledName: a.children[2].value, bytes: a.children[3].value } },
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
    const parseResult = parse(grammar, 'program', tokens, 0);
    if (parseResultIsError(parseResult)) {
        return ['unable to parse'];
    }
    return tacFromParseResult(parseResult);
};
