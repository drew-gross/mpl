import { Register, toString as registerToString } from './Register';
import { toString as statementToString, Statement } from './Statement';
import {
    ParseError,
    tokenSpecs,
    grammar,
    TacToken,
    TacAstNode,
    parseArgList,
    instructionFromParseResult,
} from './parser';
import { parseString, Ast } from '../parser-lib/parse';
import { LexError } from '../parser-lib/lex';
import join from '../util/join';
import debug from '../util/debug';

export type Function = {
    instructions: Statement[];
    arguments: Register[];
    liveAtExit: Register[];
};

export const toString = (name: string, { instructions, arguments: args }: Function): string => {
    if (!args) debug('no args');
    return join(
        [
            `(function) ${name}(${join(args.map(registerToString), ', ')}):`,
            ...instructions.map(statementToString),
        ],
        '\n'
    );
};

export const functionFromParseResult = (
    ast: Ast<TacAstNode, TacToken>
): { f: Function; name: string } => {
    const [_fn, _spillSpec, name, _lb, argsUnp, _rb, _colon, instructionsUnp] = (ast as any)
        .sequenceItems;
    let args: Register[] = parseArgList(argsUnp) as Register[];
    const instructions: Statement[] = instructionsUnp.items.map(instructionFromParseResult);
    return { f: { instructions, liveAtExit: [], arguments: args }, name };
};

export const parseFunction = (
    input: string
): { f: Function; name: string } | LexError | ParseError[] => {
    const result = parseString(tokenSpecs, grammar, 'function', input);
    if ('errors' in result) return result.errors;
    return functionFromParseResult(result);
};

export const parseFunctionOrDie = (tacString: string): { f: Function; name: string } => {
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
