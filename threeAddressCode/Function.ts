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
import { parseString, Ast, isListNode, isSeparatedListNode } from '../parser-lib/parse';
import { LexError } from '../parser-lib/lex';
import join from '../util/join';
import debug from '../util/debug';

export type Function = {
    instructions: Statement[];
    arguments: Register[];
    liveAtExit: Register[];
    name: string;
};

export const toString = ({ name, instructions, arguments: args }: Function): string => {
    if (!args) debug('no args');
    return join(
        [
            `(function) ${name}(${join(args.map(registerToString), ', ')}):`,
            ...instructions.map(statementToString),
        ],
        '\n'
    );
};

export const functionFromParseResult = (ast: Ast<TacAstNode, TacToken>): Function => {
    if (isSeparatedListNode(ast) || isListNode(ast)) {
        throw debug('todo');
    }
    if (ast.type != 'function') {
        throw debug('Need a function');
    }
    if (!('children' in ast)) {
        debug('wrong shape ast');
        throw debug('WrongShapeAst');
    }

    let childIndex = 0;
    let child = ast.children[childIndex];
    if (isSeparatedListNode(child) || isListNode(child)) {
        throw debug('todo');
    }
    if (child.type != 'function') {
        debug('wrong shape ast');
        throw debug('WrongShapeAst');
    }
    childIndex++;
    child = ast.children[childIndex];
    if (isSeparatedListNode(child) || isListNode(child)) {
        throw debug('todo');
    }
    if (child.type == 'spillSpec') {
        childIndex++;
    }
    child = ast.children[childIndex];
    if (isSeparatedListNode(child) || isListNode(child)) {
        throw debug('todo');
    }
    if (child.type != 'identifier') {
        debug('wrong shape ast');
        throw debug('WrongShapeAst');
    }
    const name = (ast.children[childIndex] as any).value;
    childIndex++;
    child = ast.children[childIndex];
    if (isSeparatedListNode(child) || isListNode(child)) {
        throw debug('todo');
    }
    if (child.type != 'leftBracket') {
        debug('wrong shape ast');
        throw debug('WrongShapeAst');
    }
    childIndex++;
    let args: Register[] = [];
    child = ast.children[childIndex];
    if (isSeparatedListNode(child)) {
        args = parseArgList(child) as Register[];
        childIndex++;
    }

    child = ast.children[childIndex];
    if (isSeparatedListNode(child) || isListNode(child)) {
        throw debug('todo');
    }
    if (child.type != 'rightBracket') {
        debug('wrong shape ast');
        throw debug('WrongShapeAst');
    }
    childIndex++;
    child = ast.children[childIndex];
    if (isSeparatedListNode(child) || isListNode(child)) {
        throw debug('todo');
    }
    if (child.type != 'colon') {
        debug('wrong shape ast');
        throw debug('WrongShapeAst');
    }
    childIndex++;
    child = ast.children[childIndex];
    if (!isListNode(child)) {
        throw debug('todo');
    }
    const instructions: Statement[] = child.items.map(instructionFromParseResult);
    return { name, instructions, liveAtExit: [], arguments: args };
};

export const parseFunction = (input: string): Function | LexError | ParseError[] => {
    const result = parseString(tokenSpecs, grammar, 'function', input);
    if ('errors' in result) return result.errors;
    return functionFromParseResult(result);
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
