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

type TacToken = 'globals' | 'colon' | 'identifier' | 'invalid';

const tokenSpecs: TokenSpec<TacToken>[] = [
    {
        token: 'globals',
        type: 'globals',
        toString: x => x,
    },
    {
        token: '\\:',
        type: 'colon',
        toString: _ => ':',
    },
    {
        token: '[a-z]\\w*',
        type: 'identifier',
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
const colon = tacTerminal('colon');
const globals = tacTerminal('globals');

const grammar: Grammar<TacAstNode, TacToken> = {
    program: Sequence('program', [globals, colon, 'globalList']),
    globalList: OneOf([Sequence('globalList', ['global', 'globalList']), 'global']),
    global: identifier,
};

const tacFromParseResult = (ast: AstWithIndex<TacAstNode, TacToken>): ThreeAddressProgram | ParseError[] => {
    switch (ast.type) {
        case 'program':
            if (ast.children[0].type != 'globals') return ['WrongShapeAst'];
            if (ast.children[1].type != 'colon') return ['WrongShapeAst'];
            return tacFromParseResult(ast.children[2]);
        case 'identifier':
            return {
                globals: { [ast.value as string]: { mangledName: 'wat', bytes: 8 } },
                functions: [],
            };
        default:
            throw debug(`${ast.type} unhandled in tacFromParseResult`);
    }
    return { globals: {}, functions: [] };
};

type ParseError = string;

export default (input: string): ThreeAddressProgram | ParseError[] => {
    const tokens = lex(tokenSpecs, input);
    if (tokens.some(t => t.type == 'invalid')) {
        return ['found an invalid token'];
    }
    const parseResult = parse(grammar, 'program', tokens, 0);
    if (parseResultIsError(parseResult)) {
        return ['unable to parse'];
    }
    return tacFromParseResult(parseResult);
};
