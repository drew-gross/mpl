import debug from '../util/debug';
import { StringLiteralData } from '../api';
import { Function, toString as functionToString, functionFromParseResult } from './Function';
import join from '../util/join';
import { ParseError, tokenSpecs, grammar, TacToken, TacAstNode } from './parser';
import { parseString, Ast, isListNode, isSeparatedListNode } from '../parser-lib/parse';
import { LexError } from '../parser-lib/lex';

export type Program = {
    globals: { [key: string]: { mangledName: string; bytes: number } };
    functions: Function[];
    main: Function | undefined; // TODO: make this not optional?
    stringLiterals: StringLiteralData[];
};

export const toString = ({ globals, functions, main }: Program): string => {
    const globalStrings = Object.keys(globals).map(
        originalName =>
            `(global) ${originalName}: ${globals[originalName].mangledName} ${globals[originalName].bytes}`
    );
    let mainStr = '';
    if (main) {
        mainStr = functionToString(main);
    }
    return `
${join(globalStrings, '\n\n')}
${mainStr}

${join(functions.map(functionToString), '\n\n')}
`;
};

const tacFromParseResult = (ast: Ast<TacAstNode, TacToken>): Program | ParseError[] => {
    if (!ast) debug('no type');
    if (isSeparatedListNode(ast)) throw debug('todo');
    if (isListNode(ast)) throw debug('todo');
    if (ast.type !== 'program') throw debug('todo');
    const parsedGlobals = ast.sequenceItems[0];
    const parsedFunctions = ast.sequenceItems[1];
    if (!isListNode(parsedGlobals)) throw debug('todo');
    if (!isListNode(parsedFunctions)) throw debug('todo');
    const globals = {};
    parsedGlobals.items.forEach((a: any) => {
        globals[a.sequenceItems[1].value] = {
            mangledName: a.sequenceItems[3].value,
            bytes: a.sequenceItems[4].value,
        };
    });
    const allFunctions = parsedFunctions.items.map(functionFromParseResult);
    let main: Function | undefined = undefined;
    const functions: Function[] = [];
    allFunctions.forEach(f => {
        if (f.name == 'main') {
            if (main) {
                throw debug('two mains');
            }
            main = f;
        } else {
            functions.push(f);
        }
    });

    return { globals, functions, main, stringLiterals: [] };
};

export const parseProgram = (input: string): Program | LexError | ParseError[] => {
    const result = parseString(tokenSpecs, grammar, 'program', input);
    if ('errors' in result) return result.errors;
    return tacFromParseResult(result);
};
