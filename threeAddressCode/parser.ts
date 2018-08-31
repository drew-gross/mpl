import { TokenSpec, lex } from '../lex.js';
import { ThreeAddressProgram } from './generator.js';
import { Grammar, Sequence, OneOf, terminal, Optional, parse } from '../parser-combinator.js';

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
const globalKw = tacTerminal('globals');

const grammar: Grammar<TacAstNode, TacToken> = {
    program: Sequence('program', [globalKw, colon, 'globalList']),
    globalList: OneOf([Sequence('globalList', ['global', 'globalList']), 'global']),
    global: identifier,
};

export default (input: string): ThreeAddressProgram => {
    const tokens = lex(tokenSpecs, input);
    console.log(tokens);
    const parsed = parse(grammar, 'program', tokens, 0);
    console.log(parsed);
    return { globalNameMap: {}, functions: [] };
};
