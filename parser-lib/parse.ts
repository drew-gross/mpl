import { Token as LToken } from './lex';
import last from '../util/list/last';
import debug from '../util/debug';
import { Graph } from 'graphlib';
import SourceLocation from './sourceLocation';
import { TokenSpec, lex, LexError } from './lex';
import { deepCopy } from 'deep-copy-ts';
import drain from '../util/list/drain';

type ListNode<Node, Leaf> = { items: Ast<Node, Leaf>[] };
export type SeparatedListNode<Node, Leaf> = {
    items: Ast<Node, Leaf>[];
    separators: Ast<Node, Leaf>[];
};

type LeafValue = string | number | null | undefined;

export type Ast<Node, Token> =
    | { type: Node; children: Ast<Node, Token>[]; sourceLocation: SourceLocation }
    | { type: Token | 'endOfFile'; value: LeafValue; sourceLocation: SourceLocation }
    | SeparatedListNode<Node, Token>
    | ListNode<Node, Token>;

export const isSeparatedListNode = <Node, Leaf>(
    n: Ast<Node, Leaf>
): n is SeparatedListNode<Node, Leaf> => 'items' in n && 'separators' in n;

export const isListNode = <Node, Leaf>(n: Ast<Node, Leaf>): n is ListNode<Node, Leaf> => {
    if (!n) throw debug('bad node');
    return 'items' in n && !('separators' in n);
};

interface LeafWithIndex<Token> {
    success: true;
    newIndex: number;
    type: Token | 'endOfFile';
    value: LeafValue;
    sourceLocation: SourceLocation;
}

interface NodeWithIndex<Node, Leaf> {
    success: true;
    newIndex: number;
    type: Node;
    children: AstWithIndex<Node, Leaf>[];
    sourceLocation: SourceLocation;
}

type AstWithIndex<Node, Token> =
    | NodeWithIndex<Node, Token>
    | LeafWithIndex<Token>
    | SeparatedListWithIndex<Node, Token>
    | ManyWithIndex<Node, Token>
    | OptionalWithIndex<Node, Token>;

type SeparatedListWithIndex<Node, Token> = {
    items: AstWithIndex<Node, Token>[];
    separators: AstWithIndex<Node, Token>[];
    newIndex: number;
};

type ManyWithIndex<Node, Token> = {
    items: AstWithIndex<Node, Token>[];
    newIndex: number;
};

type OptionalWithIndex<Node, Token> = {
    item: AstWithIndex<Node, Token> | undefined;
    newIndex: number;
};

// TODO: just put the actual Ltoken in here instead of most of it's members
export interface ParseFailureInfo<Token> {
    found: Token | 'endOfFile';
    foundTokenText: string;
    expected: Token | 'endOfFile';
    whileParsing: string[];
    sourceLocation: SourceLocation;
}

export type ParseError<Token> = { kind: 'parseError'; errors: ParseFailureInfo<Token>[] };
export type ParseResultWithIndex<Node, Token> = ParseError<Token> | AstWithIndex<Node, Token>;
export type ParseResult<Node, Token> = ParseError<Token> | Ast<Node, Token>;

export const parseResultIsError = <Node, Leaf, Token>(
    result:
        | ParseResult<Node, Token>
        | ParseResultWithIndex<Node, Token>
        | AstWithIndex<Node, Leaf>[]
        | 'missingOptional'
): result is ParseError<Token> => {
    if (result === undefined) throw debug('bad parse result');
    return result != 'missingOptional' && 'kind' in result && result.kind == 'parseError';
};

const parseResultWithIndexIsLeaf = <Node, Token>(
    r: ParseResultWithIndex<Node, Token>
): r is LeafWithIndex<Token> => 'value' in r;

// TODO also use a real sum type
const parseResultWithIndexIsSeparatedList = <Node, Token>(
    r: ParseResultWithIndex<Node, Token>
): r is SeparatedListWithIndex<Node, Token> => 'items' in r && 'separators' in r;

const parseResultWithIndexIsList = <Node, Token>(
    r: ParseResultWithIndex<Node, Token>
): r is ManyWithIndex<Node, Token> => 'items' in r && !('separators' in r);

const stripNodeIndexes = <Node, Leaf>(r: AstWithIndex<Node, Leaf>): Ast<Node, Leaf> => {
    if (parseResultWithIndexIsLeaf(r)) {
        return { value: r.value, type: r.type, sourceLocation: r.sourceLocation };
    }
    if (parseResultWithIndexIsSeparatedList(r)) {
        return {
            items: r.items.map(stripNodeIndexes),
            separators: r.separators.map(stripNodeIndexes),
        };
    }
    if (parseResultWithIndexIsList(r)) {
        return { items: r.items.map(stripNodeIndexes) };
    }
    // TODO: Should fix optional handling to work more like the new parser when skipping missing items
    if ('item' in r) {
        throw debug('TODO: better optional handling');
    }
    if (!r.children) debug('expected children');
    const childrenWithFixedOptionals: any[] = [];
    for (const c of r.children) {
        if ('item' in c) {
            if (c.item) {
                childrenWithFixedOptionals.push(c.item);
            }
        } else {
            childrenWithFixedOptionals.push(c);
        }
    }
    return {
        type: r.type,
        children: childrenWithFixedOptionals.map(stripNodeIndexes) as any,
        sourceLocation: r.sourceLocation,
    };
};

const stripResultIndexes = <Node, Token>(
    r: ParseResultWithIndex<Node, Token>
): ParseResult<Node, Token> => {
    if (parseResultIsError(r)) {
        return r;
    }
    return stripNodeIndexes(r);
};

export const stripSourceLocation = ast => {
    if ('children' in ast) {
        return { type: ast.type, children: ast.children.map(stripSourceLocation) };
    } else {
        return { type: ast.type, value: ast.value };
    }
};

type Terminal<Node, Token> = { kind: 'terminal'; token: Token };
type BaseParser<Node, Token> = string | Terminal<Node, Token>;
type Sequence<Node, Token> = { kind: 'sequence'; name: string; parsers: Parser<Node, Token>[] };
type Alternative<Node, Token> = { kind: 'oneOf'; parsers: Parser<Node, Token>[] };
type Optional<Node, Token> = { kind: 'optional'; parser: Parser<Node, Token> };
type SeparatedList<Node, Token> = {
    kind: 'separatedList';
    separator: Parser<Node, Token>;
    item: Parser<Node, Token>;
};
type Many<Node, Token> = {
    kind: 'many';
    item: Parser<Node, Token>;
};
type Nested<Node, Token> = {
    kind: 'nested';
    in: Nesting<Node, Token>;
    parser: Parser<Node, Token>;
};

type Parser<Node, Token> =
    | Alternative<Node, Token>
    | Sequence<Node, Token>
    | BaseParser<Node, Token>
    | Optional<Node, Token>
    | SeparatedList<Node, Token>
    | Many<Node, Token>
    | Nested<Node, Token>;

export const Sequence = <Node extends string, Token>(
    name: Node,
    parsers: Parser<Node, Token>[]
): Sequence<Node, Token> => ({ kind: 'sequence', name, parsers });

export const OneOf = <Node, Token>(
    parsers: Parser<Node, Token>[]
): Alternative<Node, Token> => ({ kind: 'oneOf', parsers });

export const Optional = <Node, Token>(parser: Parser<Node, Token>): Optional<Node, Token> => ({
    kind: 'optional',
    parser,
});

export const SeparatedList = <Node, Token>(
    separator: Parser<Node, Token>,
    item: Parser<Node, Token>
): SeparatedList<Node, Token> => ({ kind: 'separatedList', separator, item });

export type Nesting<Node, Token> = {
    left: Parser<Node, Token>;
    right: Parser<Node, Token>;
};

export const NestedIn = <Node, Token>(
    nesting: Nesting<Node, Token>,
    parser: Parser<Node, Token>
): Nested<Node, Token> => ({ kind: 'nested', in: nesting, parser });

export const Many = <Node, Token>(item: Parser<Node, Token>): Many<Node, Token> => ({
    kind: 'many',
    item,
});

export interface Grammar<Node, Token> {
    // Ideally would have Node instead of string here but typescript doesn't allow that.
    [index: string]: Parser<Node, Token>;
}

const getSourceLocation = <Token>(tokens: LToken<Token>[], index: number): SourceLocation => {
    if (tokens.length == 0) {
        return { line: 0, column: 0 };
    } else if (index >= tokens.length) {
        const lastToken: LToken<Token> = last(tokens) as LToken<Token>;
        return {
            line: lastToken.sourceLocation.line,
            column: lastToken.sourceLocation.column + lastToken.string.length,
        };
    } else if (index < 0) {
        return { line: 0, column: 0 };
    } else {
        return tokens[index].sourceLocation;
    }
};

const isTerminalParser = <Node, Token>(p: Parser<Node, Token>): p is Terminal<Node, Token> =>
    typeof p == 'object' && 'kind' in p && p.kind === 'terminal';

const parseSequence = <Node extends string, Token>(
    grammar: Grammar<Node, Token>,
    parser: Sequence<Node, Token>,
    tokens: LToken<Token>[],
    index: number
): ParseResultWithIndex<Node, Token> => {
    const originalIndex = index;
    const results: AstWithIndex<Node, Token>[] = [];
    for (const p of parser.parsers) {
        let result: ParseResultWithIndex<Node, Token>;
        if (isTerminalParser(p)) {
            result = parseTerminal(p, tokens, index);
        } else if (typeof p === 'string') {
            result = parseRule(grammar, p as Node, tokens, index);
        } else if (p.kind == 'optional') {
            // TODO: Possibly they wanted the optional but had syntax error. If this is the case, we should get an error and do something useful with it (display it)
            // TODO: Handle case of parsing "x" with "x?x" where successfully parsing optional may cause remaining parse to fail and we need to try again without the optional.
            const maybeResult = parseOptional(grammar, p, tokens, index);
            if (!maybeResult) {
                continue; // Skip to the next non-optional
            } else {
                result = maybeResult;
            }
        } else if (p.kind == 'many') {
            result = parseMany(grammar, p, tokens, index);
        } else if (p.kind == 'nested') {
            result = parseNested(grammar, p, tokens, index);
        } else {
            throw debug(`Invalid parser type: ${JSON.stringify(p)}`);
        }

        if (parseResultIsError(result)) {
            result.errors.forEach(e => {
                e.whileParsing.unshift(parser.name);
            });
            return result;
        }

        results.push(result);
        index = result.newIndex;
    }
    return {
        success: true,
        newIndex: index,
        type: parser.name as Node,
        children: results,
        sourceLocation: getSourceLocation(tokens, originalIndex),
    };
};

type ParserProgress<Node, Token> =
    | { kind: 'failed'; error: ParseError<Token> }
    /* prettier-ignore */
    | { kind: 'progress'; parseResults: AstWithIndex<Node, Token>[]; subParserIndex: number; };

const parseAlternative = <Node extends string, Token>(
    grammar: Grammar<Node, Token>,
    alternatives: Alternative<Node, Token>,
    tokens: LToken<Token>[],
    index: number
): ParseResultWithIndex<Node, Token> => {
    const progressCache: ParserProgress<Node, Token>[] = alternatives.parsers.map(
        _ =>
            ({ kind: 'progress', parseResults: [], subParserIndex: 0 }) as ParserProgress<
                Node,
                Token
            >
    );

    // TODO: fix this linter error
    // tslint:disable-next-line
    for (
        let alternativeIndex = 0;
        alternativeIndex < alternatives.parsers.length;
        alternativeIndex++
    ) {
        let alternativeNeedsSubtracting = false;
        let currentParser = alternatives.parsers[alternativeIndex];
        let currentResult: ParseResultWithIndex<Node, Token> | 'missingOptional';
        let currentIndex: number;
        const currentProgress = progressCache[alternativeIndex];

        // Check if we have cached an error for this parser. If we have, continue to the next parser.
        if (currentProgress.kind == 'failed') {
            continue;
        }
        if (!currentParser) throw debug('no currentParser');

        if (typeof currentParser === 'string') {
            // Reference to another rule.
            if (currentProgress.subParserIndex == 1) {
                // We already finished this one earlier. It must be a prefix of an earlier rule.
                return currentProgress.parseResults[0];
            } else {
                // We haven't tried this parser yet. Try it now.
                currentResult = parseAnything(grammar, currentParser, tokens, index);
                currentIndex = 0;
                if (!parseResultIsError(currentResult)) {
                    return currentResult;
                } else {
                    progressCache[alternativeIndex] = { kind: 'failed', error: currentResult };
                }
            }
        } else if (isTerminalParser(currentParser)) {
            // Terminal.
            if (currentProgress.subParserIndex == 1) {
                // We already finished this one earlier. It must be a prefix of an earlier rule.
                return currentProgress.parseResults[0];
            } else {
                // We haven't tried this parser yet. Try it now.
                currentResult = parseTerminal(currentParser, tokens, index);
                currentIndex = 0;
                if (!parseResultIsError(currentResult)) {
                    return currentResult;
                } else {
                    progressCache[alternativeIndex] = { kind: 'failed', error: currentResult };
                }
            }
        } else if (currentParser.kind == 'nested') {
            throw debug(
                'should figure out a way to do nested inside alternative - probably need a more generic framework'
            );
        } else if (currentParser.kind == 'sequence') {
            // Sequence. This is the complex one.

            // Next get the parser for the next item in the sequence based on how much progress we have made due
            // to being a prefix of previous rules.
            const sequenceParser = currentParser;
            currentParser = currentParser.parsers[currentProgress.subParserIndex];

            const currentProgressLastItem = last(currentProgress.parseResults);
            if (
                currentProgressLastItem !== null &&
                parseResultIsError(currentProgressLastItem)
            ) {
                throw debug('todo');
            }
            const tokenIndex =
                currentProgressLastItem !== null ? currentProgressLastItem.newIndex : index;
            // Check if this parser has been completed due to being a successful prefix of a previous alternative
            if (
                currentProgressLastItem !== null &&
                currentProgress.subParserIndex === sequenceParser.parsers.length
            ) {
                return {
                    newIndex: currentProgressLastItem.newIndex,
                    success: true,
                    children: currentProgress.parseResults,
                    type: sequenceParser.name as Node,
                    sourceLocation: getSourceLocation(tokens, index),
                };
            }

            // We still need to do work on this parser
            if (isTerminalParser(currentParser)) {
                currentResult = parseTerminal(currentParser, tokens, tokenIndex);
                currentIndex = currentProgress.subParserIndex;
            } else if (typeof currentParser == 'string') {
                currentResult = parseRule(grammar, currentParser as Node, tokens, tokenIndex);
                currentIndex = currentProgress.subParserIndex;
            } else if (currentParser.kind == 'optional') {
                const optionalResult = parseOptional(grammar, currentParser, tokens, tokenIndex);
                if (optionalResult === undefined) {
                    currentResult = 'missingOptional';
                } else {
                    currentResult = optionalResult;
                }
                currentIndex = currentProgress.subParserIndex;
            } else if (currentParser.kind == 'nested') {
                currentResult = parseNested(grammar, currentParser, tokens, tokenIndex);
                currentIndex = currentProgress.subParserIndex;
            } else {
                throw debug(`unhandled kind of parser: ${currentParser.kind}`);
            }

            // Push the results into the cache for the current parser
            if (parseResultIsError(currentResult)) {
                progressCache[alternativeIndex] = { kind: 'failed', error: currentResult };
            } else {
                if (progressCache[alternativeIndex].kind != 'failed') {
                    if (currentResult !== 'missingOptional') {
                        (progressCache[alternativeIndex] as any).parseResults.push(
                            currentResult
                        );
                    }
                    (progressCache[alternativeIndex] as any).subParserIndex++;
                }

                // When we return to the top of this loop, we want to continue parsing the current sequence.
                // In order to make this happen, flag that we need to subtract one from alternativesIndex.
                // TODO: Be less janky. Probably turning the for into a while that says "while we have alternatives
                // that haven't reached an error yet".
                alternativeNeedsSubtracting = true;
            }

            // Check if we are done
            const refreshedCurrentProgress = progressCache[alternativeIndex];
            if (
                refreshedCurrentProgress.kind != 'failed' &&
                refreshedCurrentProgress.subParserIndex == sequenceParser.parsers.length
            ) {
                const cachedSuccess = last(refreshedCurrentProgress.parseResults);
                if (cachedSuccess === null) throw debug('cachedSuccess == null');
                if (parseResultIsError(cachedSuccess)) {
                    throw debug('todo');
                }
                return {
                    newIndex: cachedSuccess.newIndex,
                    success: true,
                    children: refreshedCurrentProgress.parseResults,
                    type: sequenceParser.name as Node,
                    sourceLocation: getSourceLocation(tokens, index),
                };
            }
        } else {
            throw debug('a parser type was not handled');
        }

        // Now we have a parse result and the index it was found at. Push it into the progress cache
        // for each alternative that has parsed up to that index and expects the next item to be of that type.
        for (
            let progressCacheIndex = alternativeIndex;
            progressCacheIndex < alternatives.parsers.length;
            progressCacheIndex++
        ) {
            const parser = alternatives.parsers[progressCacheIndex];
            const progressRef = progressCache[progressCacheIndex];
            if (progressRef.kind != 'failed' && progressRef.subParserIndex == currentIndex) {
                if (typeof parser === 'string' && currentParser == parser) {
                    if (parseResultIsError(currentResult)) {
                        progressCache[progressCacheIndex] = {
                            kind: 'failed',
                            error: currentResult,
                        };
                    } else if (currentResult != 'missingOptional') {
                        progressRef.parseResults.push(currentResult);
                        progressRef.subParserIndex++;
                    }
                } else if (typeof parser === 'function' && currentParser == parser) {
                    if (parseResultIsError(currentResult)) {
                        progressCache[progressCacheIndex] = {
                            kind: 'failed',
                            error: currentResult,
                        };
                    } else if (currentResult != 'missingOptional') {
                        progressRef.parseResults.push(currentResult);
                        progressRef.subParserIndex++;
                    }
                } else if (
                    typeof parser != 'string' &&
                    typeof parser != 'function' &&
                    parser.kind == 'sequence' &&
                    currentParser === parser.parsers[currentIndex]
                ) {
                    if (parseResultIsError(currentResult)) {
                        progressCache[progressCacheIndex] = {
                            kind: 'failed',
                            error: currentResult,
                        };
                    } else if (currentResult != 'missingOptional') {
                        progressRef.parseResults.push(currentResult);
                        progressRef.subParserIndex++;
                    }
                } else if (
                    typeof parser != 'string' &&
                    typeof parser != 'function' &&
                    parser.kind == 'optional' &&
                    currentParser == parser.parser
                ) {
                    if (
                        currentResult != 'missingOptional' &&
                        !parseResultIsError(currentResult)
                    ) {
                        (progressCache[progressCacheIndex] as any).parseResults.push(
                            currentResult
                        );
                    }
                    (progressCache[progressCacheIndex] as any).subParserIndex++;
                }
            }
        }

        if (alternativeNeedsSubtracting) {
            alternativeIndex--;
        }
    }

    const errors: ParseError<Token> = { kind: 'parseError', errors: [] };
    progressCache.forEach(progress => {
        if (progress.kind == 'failed') {
            errors.errors.push(...progress.error.errors);
        } else {
            throw debug('everything should have failed by now');
        }
    });
    errors.errors.sort((l, r) => {
        if (l.sourceLocation.line != r.sourceLocation.line) {
            return r.sourceLocation.line - l.sourceLocation.line;
        }
        return r.sourceLocation.column - l.sourceLocation.column;
    });
    return errors;
};

const parseSeparatedList = <Node extends string, Token>(
    grammar: Grammar<Node, Token>,
    sep: SeparatedList<Node, Token>,
    tokens: LToken<Token>[],
    index: number
): SeparatedListWithIndex<Node, Token> | ParseError<Token> => {
    const item = parseAnything(grammar, sep.item, tokens, index);
    if (parseResultIsError(item)) {
        return { items: [], separators: [], newIndex: index };
    }
    const separator = parseAnything(grammar, sep.separator, tokens, item.newIndex);
    if (parseResultIsError(separator)) {
        return { items: [item], separators: [], newIndex: item.newIndex };
    }
    const next = parseSeparatedList(grammar, sep, tokens, separator.newIndex);
    if (parseResultIsError(next)) {
        return next;
    }
    return {
        items: [item, ...next.items],
        separators: [separator, ...next.separators],
        newIndex: next.newIndex,
    };
};

const parseNested = <Node extends string, Token>(
    grammar: Grammar<Node, Token>,
    nested: Nested<Node, Token>,
    tokens: LToken<Token>[],
    index: number
): ParseResultWithIndex<Node, Token> => {
    const leftNest = parseAnything(grammar, nested.in.left, tokens, index);
    if (parseResultIsError(leftNest)) {
        return leftNest;
    }
    const result = parseAnything(grammar, nested.parser, tokens, leftNest.newIndex);
    if (parseResultIsError(result)) {
        return result;
    }
    const rightNest = parseAnything(grammar, nested.in.right, tokens, result.newIndex);
    if (parseResultIsError(rightNest)) {
        return rightNest;
    }
    return { ...result, newIndex: rightNest.newIndex };
};

const parseMany = <Node extends string, Token>(
    grammar: Grammar<Node, Token>,
    many: Many<Node, Token>,
    tokens: LToken<Token>[],
    index: number
): ManyWithIndex<Node, Token> | ParseError<Token> => {
    const item = parseAnything(grammar, many.item, tokens, index);
    if (parseResultIsError(item)) {
        return { items: [], newIndex: index };
    }
    const next = parseMany(grammar, many, tokens, item.newIndex);
    if (parseResultIsError(next)) {
        return { items: [item], newIndex: item.newIndex };
    }
    return { items: [item, ...next.items], newIndex: next.newIndex };
};

const parseAnything = <Node extends string, Token>(
    grammar: Grammar<Node, Token>,
    parser: Parser<Node, Token>,
    tokens: LToken<Token>[],
    index: number
): ParseResultWithIndex<Node, Token> => {
    try {
        if (typeof parser === 'string') {
            return parseRule(grammar, parser as Node, tokens, index);
        } else if (isTerminalParser(parser)) {
            return parseTerminal(parser, tokens, index);
        } else if (parser.kind == 'sequence') {
            return parseSequence(grammar, parser, tokens, index);
        } else if (parser.kind == 'oneOf') {
            return parseAlternative(grammar, parser, tokens, index);
        } else if (parser.kind == 'separatedList') {
            return parseSeparatedList(grammar, parser, tokens, index);
        } else if (parser.kind == 'many') {
            return parseMany(grammar, parser, tokens, index);
        } else if (parser.kind == 'nested') {
            return parseNested(grammar, parser, tokens, index);
        } else {
            throw debug('bad type in parse');
        }
    } catch (e) {
        if (e instanceof RangeError) {
            parseAnything(grammar, parser, tokens, index);
            debug('range error');
        }
        throw e;
    }
};

const parseOptional = <Node extends string, Token>(
    grammar: Grammar<Node, Token>,
    optional: Optional<Node, Token>,
    tokens: LToken<Token>[],
    index: number
): ParseResultWithIndex<Node, Token> | undefined => {
    const result = parseAnything(grammar, optional.parser, tokens, index);
    if (parseResultIsError(result)) {
        return undefined;
    }
    return result;
};

const parseTerminal = <Node, Token>(
    terminal: Terminal<Node, Token>,
    tokens: LToken<Token>[],
    index
): ParseResultWithIndex<Node, Token> => {
    if (index >= tokens.length) {
        return {
            kind: 'parseError',
            errors: [
                {
                    found: 'endOfFile',
                    foundTokenText: 'endOfFile',
                    expected: terminal.token,
                    whileParsing: [],
                    sourceLocation:
                        index > tokens.length
                            ? getSourceLocation(tokens, index)
                            : getSourceLocation(tokens, tokens.length - 1),
                },
            ],
        };
    }
    if (tokens[index].type == terminal.token) {
        return {
            success: true,
            newIndex: index + 1,
            value: tokens[index].value,
            type: tokens[index].type,
            sourceLocation: getSourceLocation(tokens, index),
        };
    }

    return {
        kind: 'parseError',
        errors: [
            {
                expected: terminal.token,
                found: tokens[index].type,
                foundTokenText: tokens[index].string,
                whileParsing: [],
                // Use index of prevoius Ltoken so that the parse error shows up right
                // after the place where the user should have done something (e.g. they
                // place where they forgot the semicolon
                sourceLocation: getSourceLocation(tokens, index - 1),
            },
        ],
    };
};

export const Terminal = <Node, Token>(Ltoken: Token): Terminal<Node, Token> => ({
    kind: 'terminal',
    token: Ltoken,
});

export const toDotFile = <Node extends string, Token>(ast: Ast<Node, Token>) => {
    const digraph = new Graph();
    let id = 0;
    const traverse = (node: Ast<Node, Token>): number => {
        const myId = id;
        id++;

        let children: Ast<Node, Token>[] = [];
        let nodeString = '';
        if (isSeparatedListNode(node)) {
            // TODO: make this prettier as a node within the tree than just "seplist"
            nodeString = 'seplist';
            // TODO: interleave the items and separators for better display
            children = [...node.items, ...node.separators];
        } else if (isListNode(node)) {
            // TODO: make this prettier as a node within the tree than just "list"
            nodeString = 'list';
            children = node.items;
        } else if ('children' in node) {
            nodeString = node.type;
            children = node.children;
        } else {
            nodeString = `${node.type}\n${node.value ? node.value : ''}`;
        }

        // Create a new graphviz node for this ast node
        digraph.setNode(myId, { label: nodeString });

        // Recursively create nodes for this node's children
        const childIds = children.map(traverse);

        // Add an edge from this node to each child
        // @ts-ignore
        children.forEach((child, index) => {
            digraph.setEdge(myId, childIds[index]);
        });
        return myId;
    };
    traverse(ast);
    return digraph;
};

const parseRule = <Node extends string, Token>(
    grammar: Grammar<Node, Token>,
    rule: Node,
    tokens: LToken<Token>[],
    index: number
): ParseResultWithIndex<Node, Token> => {
    const childrenParser: Parser<Node, Token> = grammar[rule];
    if (!childrenParser) throw debug(`invalid rule name: ${rule}`);
    return parseAnything(grammar, childrenParser, tokens, index);
};

type PartialAst<Node, Token> =
    | EmptySlot<Node, Token>
    | PartialToken<Token>
    | PartialMany<Node, Token>
    | PartialSequence<Node, Token>
    | EmptySeparatedList
    | PartialSeparatedList<Node, Token>
    | PartialNested<Node, Token>
    | PartialOptional<Node, Token>;
type PartialSequence<Node, Token> = {
    sequenceItems: PartialAst<Node, Token>[];
    name: string;
    sourceLocation: SourceLocation;
};
type EmptySeparatedList = {
    emptySeparatedList: true;
};
// TOOD: Maybe use separate types for many/separated list with and without more items?
type PartialMany<Node, Token> = {
    items: PartialAst<Node, Token>[];
    remainingItems?: PartialMany<Node, Token>;
};
type PartialSeparatedList<Node, Token> = {
    item: PartialAst<Node, Token>;
    separator?: PartialAst<Node, Token>;
    remainingItems?: PartialSeparatedList<Node, Token>;
};
type PartialToken<Token> = {
    tokenType: Token;
    value: LeafValue;
    ltoken: LToken<Token>;
};
type PartialNested<Node, Token> = {
    left: PartialAst<Node, Token>;
    enclosed: PartialAst<Node, Token>;
    right: PartialAst<Node, Token>;
};
type PartialOptional<Node, Token> = {
    present: boolean;
    item?: PartialAst<Node, Token>;
};
type EmptySlot<Node, Token> = {
    rule: Parser<Node, Token>;
};
type ExpectedToken<Token> = {
    expected: Token[];
};

type PotentialAstsResult<Node, Token> = {
    partial: PartialAst<Node, Token>;
    madeProgress: boolean;
};
const getPotentialAsts = <Node extends string, Token>(
    grammar: Grammar<Node, Token>,
    parser: Parser<Node, Token>,
    token: LToken<Token> | 'endOfFile'
): PotentialAstsResult<Node, Token>[] | ExpectedToken<Token> => {
    if (parser === undefined) throw debug('bad parser');
    if (typeof parser == 'string') return getPotentialAsts(grammar, grammar[parser], token);
    switch (parser.kind) {
        case 'terminal':
            if (token === 'endOfFile') {
                return { expected: [parser.token] };
            }
            if (parser.token === token.type) {
                return [
                    {
                        partial: { tokenType: token.type, value: token.value, ltoken: token },
                        madeProgress: true,
                    },
                ];
            } else {
                return { expected: [parser.token] };
            }
        case 'many': {
            const result = getPotentialAsts(grammar, parser.item, token);
            // If we didn't parse an item, we have completed the many items
            const parsesWithNoItems: PotentialAstsResult<Node, Token>[] = [
                { partial: { items: [] }, madeProgress: false },
            ];

            if ('expected' in result) {
                return parsesWithNoItems;
            }
            // If we did parse an item, there also might still be more items, so indicate that we need to try parsing another item
            const parsesWithMoreItems = result.map(({ partial, madeProgress }) => ({
                // TODO: rename items to item since it no longer contains multiple and it's more like a linked list
                partial: { items: [partial], remainingItems: { rule: parser } },
                madeProgress: madeProgress,
            })) as any;
            return [...parsesWithMoreItems, ...parsesWithNoItems];
        }
        case 'oneOf':
            const errors: ExpectedToken<Token> = { expected: [] };
            const partials: PotentialAstsResult<Node, Token>[] = [];
            for (const p of parser.parsers) {
                const result = getPotentialAsts(grammar, p, token);
                if ('expected' in result) {
                    errors.expected.push(...result.expected);
                } else {
                    partials.push(...result);
                }
            }
            if (partials.length > 0) {
                return partials;
            }
            return errors;
        case 'sequence': {
            // TODO: We only seem to use the first element?
            for (const seqParser of parser.parsers) {
                const result = getPotentialAsts(grammar, seqParser, token);
                if ('expected' in result) {
                    return result;
                }
                const empties: PartialAst<Node, Token>[] = parser.parsers.map(p => ({
                    rule: p,
                }));
                // remove first element and replace it with successful partial parse
                empties.shift();
                return result.map(({ partial, madeProgress, ...rest }) => ({
                    partial: {
                        sequenceItems: [{ ...partial, ...rest }, ...empties],
                        name: parser.name,
                        sourceLocation:
                            token !== 'endOfFile'
                                ? token.sourceLocation
                                : { column: 0, line: 0 },
                    },
                    madeProgress: madeProgress,
                }));
            }
            throw debug('All optionals of sequence missing');
        }
        case 'optional': {
            const missingOptional = { partial: { present: false }, madeProgress: false };
            const result = getPotentialAsts(grammar, parser.parser, token);
            if ('expected' in result) {
                return [missingOptional];
            } else {
                return [
                    missingOptional,
                    ...result.map(({ partial, madeProgress }) => ({
                        partial: { present: true, item: partial },
                        madeProgress: madeProgress,
                    })),
                ];
            }
        }
        case 'nested': {
            const result = getPotentialAsts(grammar, parser.in.left, token);
            if ('expected' in result) {
                return result;
            }
            return result.map(({ partial, madeProgress }) => ({
                partial: {
                    left: partial,
                    enclosed: { rule: parser.parser },
                    right: { rule: parser.in.right },
                },
                madeProgress,
            }));
        }
        case 'separatedList': {
            const result = getPotentialAsts(grammar, parser.item, token);
            const parsesWithNoItems: PotentialAstsResult<Node, Token>[] = [
                { partial: { emptySeparatedList: true }, madeProgress: false },
            ];
            if ('expected' in result) {
                return parsesWithNoItems;
            }
            // TODO: Include already parsed items and separators somehow
            const parsesWithNoMoreItems = result.map(({ partial, madeProgress }) => ({
                partial: { item: partial },
                madeProgress: madeProgress,
            }));
            const parsesWithMoreItems = result.map(({ partial, madeProgress }) => ({
                partial: {
                    item: partial,
                    separator: { rule: parser.separator },
                    remainingItems: { rule: parser },
                },
                madeProgress,
            }));
            // NOTE: Need to handle the case where the token indicates that we could parse an item, but
            // the item after that indicates that we can't, and we need to successfully parse a zero item
            // separated list, followed by a successful parse of whatever comes next
            return [...parsesWithNoMoreItems, ...parsesWithMoreItems, ...parsesWithNoItems];
        }
        default: {
            throw debug(`unhandled parser kind`);
        }
    }
};

const getRuleForNextEmptySlot = <Node, Token>(
    ast: PartialAst<Node, Token>
): Parser<Node, Token> | undefined => {
    if ('rule' in ast) {
        return ast.rule as any;
    } else if ('sequenceItems' in ast) {
        for (const item of ast.sequenceItems) {
            if ('rule' in item) {
                return item.rule;
            }
            const nextSequenceItemRule = getRuleForNextEmptySlot(item);
            if (nextSequenceItemRule) {
                return nextSequenceItemRule;
            }
        }
        return undefined;
    } else if ('tokenType' in ast) {
        return undefined;
    } else if ('present' in ast) {
        if (!ast.present) {
            return undefined;
        } else if (ast.item) {
            return getRuleForNextEmptySlot(ast.item);
        } else {
            throw debug('bad item');
        }
    } else if ('left' in ast) {
        const left = getRuleForNextEmptySlot(ast.left);
        if (left) {
            return left;
        }
        const enclosed = getRuleForNextEmptySlot(ast.enclosed);
        if (enclosed) {
            return enclosed;
        }
        return getRuleForNextEmptySlot(ast.right);
    } else if ('separator' in ast) {
        // If the last item isn't finished, we need to finish it before looking for the separator
        const item = getRuleForNextEmptySlot(ast.item);
        if (item) {
            return item;
        }
        // If there is no separator there is no next item
        if (!ast.separator) {
            return undefined;
        }
        // If the last separator isn't finished, finish the separator
        const sep = getRuleForNextEmptySlot(ast.separator);
        if (sep) {
            return sep;
        }
        // If there is no option for a new item, this node is finished
        if (!ast.remainingItems) {
            return undefined;
        }
        // Otherwise finish the next item
        return getRuleForNextEmptySlot(ast.remainingItems);
    } else if ('item' in ast) {
        return getRuleForNextEmptySlot(ast.item);
    } else if ('emptySeparatedList' in ast) {
        return undefined;
    } else if ('items' in ast) {
        // many
        // first try to finish any in-progress items
        for (const item of ast.items) {
            const itemRule = getRuleForNextEmptySlot(item);
            if (itemRule) {
                return itemRule;
            }
        }
        // then try to start a new item
        if ('remainingItems' in ast) {
            // many with more items
            return getRuleForNextEmptySlot(ast.remainingItems as PartialMany<Node, Token>);
        }
        // then, return that we've completed the many
        return undefined;
    }
    throw debug(`unhandled: ${ast}`);
};
const replaceRuleForNextEmptySlotWithPartial = <Node, Token>(
    ast: PartialAst<Node, Token>,
    replacement: PartialAst<Node, Token>
): boolean => {
    if ('rule' in ast) {
        delete (ast as any).rule;
        Object.assign(ast, replacement);
        return true;
    } else if ('sequenceItems' in ast) {
        for (const item of ast.sequenceItems) {
            if (replaceRuleForNextEmptySlotWithPartial(item, replacement)) {
                return true;
            }
        }
        return false;
    } else if ('tokenType' in ast) {
        return false;
    } else if ('present' in ast) {
        if (!ast.present) {
            return false;
        } else if (ast.item) {
            return replaceRuleForNextEmptySlotWithPartial(ast.item, replacement);
        } else {
            throw debug('bad item');
        }
    } else if ('left' in ast) {
        if (replaceRuleForNextEmptySlotWithPartial(ast.left, replacement)) {
            return true;
        }
        if (replaceRuleForNextEmptySlotWithPartial(ast.enclosed, replacement)) {
            return true;
        }
        return replaceRuleForNextEmptySlotWithPartial(ast.right, replacement);
    } else if ('separator' in ast) {
        if (replaceRuleForNextEmptySlotWithPartial(ast.item, replacement)) {
            return true;
        }
        if (
            ast.separator &&
            replaceRuleForNextEmptySlotWithPartial(ast.separator, replacement)
        ) {
            return true;
        }
        if (!ast.remainingItems) {
            return false;
        }
        return replaceRuleForNextEmptySlotWithPartial(ast.remainingItems, replacement);
    } else if ('item' in ast) {
        return replaceRuleForNextEmptySlotWithPartial(ast.item, replacement);
    } else if ('emptySeparatedList' in ast) {
        return false;
    } else if ('items' in ast) {
        // Replace in the next in-progress item
        for (const item of ast.items) {
            const replaced = replaceRuleForNextEmptySlotWithPartial(item, replacement);
            if (replaced) {
                return true;
            }
        }
        // If no in-progress items, start the next item
        if ('remainingItems' in ast) {
            return replaceRuleForNextEmptySlotWithPartial(
                ast.remainingItems as any,
                replacement
            );
        }
        // Otherwise, continue to the next rule
        return false;
    }
    throw debug(`unhandled: ${ast}`);
};

const partialAstToCompleteAst = <Node, Token>(
    ast: PartialAst<Node, Token>
): AstWithIndex<Node, Token> => {
    if ('rule' in ast) {
        throw debug('was supposed to be complete');
    } else if ('items' in ast) {
        const flattenRemainingItems = (many: PartialMany<Node, Token>) => {
            const remaining: PartialAst<Node, Token>[] = many.remainingItems
                ? flattenRemainingItems(many.remainingItems)
                : [];
            return [...many.items, ...remaining];
        };
        return {
            items: flattenRemainingItems(ast).map(partialAstToCompleteAst),
            newIndex: 0,
        };
    } else if ('sequenceItems' in ast) {
        const sequenceHasTrailingMissingOptional = seq => {
            const backItem = seq[seq.length - 1];
            return backItem && 'rule' in backItem && backItem.rule.kind == 'optional';
        };
        while (sequenceHasTrailingMissingOptional(ast.sequenceItems)) {
            ast.sequenceItems.pop();
        }
        return {
            success: true,
            newIndex: 0,
            type: ast.name as Node,
            children: ast.sequenceItems.map(partialAstToCompleteAst),
            sourceLocation: ast.sourceLocation,
        };
    } else if ('tokenType' in ast) {
        return {
            success: true,
            newIndex: 0,
            type: ast.tokenType,
            value: ast.value,
            sourceLocation: ast.ltoken.sourceLocation,
        };
    } else if ('left' in ast) {
        // TODO: Return into about the separators? Maybe only if asked.
        return partialAstToCompleteAst(ast.enclosed);
    } else if ('emptySeparatedList' in ast) {
        return {
            items: [],
            separators: [],
            newIndex: 0,
        };
    } else if ('present' in ast) {
        if (ast.present) {
            return { item: partialAstToCompleteAst(ast.item as any), newIndex: 0 };
        } else {
            return { item: undefined, newIndex: 0 };
        }
    } else if ('separator' in ast) {
        const flattenPartialSeparatedList = (list: PartialSeparatedList<Node, Token>) => {
            const item = partialAstToCompleteAst(list.item);
            const newSeparators = list.separator
                ? [partialAstToCompleteAst(list.separator)]
                : [];
            const { items, separators } = list.remainingItems
                ? flattenPartialSeparatedList(list.remainingItems)
                : { items: [], separators: [] };
            return { items: [item, ...items], separators: [...newSeparators, ...separators] };
        };
        return {
            ...flattenPartialSeparatedList(ast),
            newIndex: 0,
        };
    } else if ('item' in ast) {
        return {
            items: [partialAstToCompleteAst(ast.item)],
            separators: [],
            newIndex: 0,
        };
    }
    throw debug(`unhandled conversion: ${ast}`);
};

// TODO: Return errors OR partials, at this layer we don't need both.
const applyTokenToPartialParse = <Node, Token>(
    grammar: Grammar<Node, Token>,
    partial: PartialAst<Node, Token>,
    token: LToken<Token>
) => {
    const errors: ExpectedToken<Token> = { expected: [] };
    const partials: PartialAst<Node, Token>[] = [];
    let rule = getRuleForNextEmptySlot(partial);
    if (!rule) {
        errors.expected.push('endOfFile' as Token);
        return { errors, partials };
    }
    const result = getPotentialAsts(grammar, rule, token);
    // Couldn't find any valid continuations: Must be an error
    if ('expected' in result) {
        errors.expected.push(...result.expected);
    } else {
        for (const newProgress of result) {
            // If we used the token, hooray! Return the new partial tree
            if (newProgress.madeProgress) {
                const existingProgress = deepCopy(partial);
                if (
                    replaceRuleForNextEmptySlotWithPartial(existingProgress, newProgress.partial)
                ) {
                    partials.push(existingProgress);
                }
            } else {
                // If we found a missing optional or an empty list, we need to apply the token to the next item.
                const existingProgress = deepCopy(partial);
                if (
                    !replaceRuleForNextEmptySlotWithPartial(
                        existingProgress,
                        newProgress.partial
                    )
                ) {
                    throw debug(
                        'should have replaced I think? being here implies we should be replacing something with a missing optional/empty list'
                    );
                }
                const appliedToNext = applyTokenToPartialParse(grammar, existingProgress, token);
                errors.expected.push(...appliedToNext.errors.expected);
                partials.push(...appliedToNext.partials);
            }
        }
    }
    return { errors, partials };
};

export const parseRule2 = <Node extends string, Token>(
    grammar: Grammar<Node, Token>,
    rule: Node,
    tokens: LToken<Token>[]
): ParseResult<Node, Token> => {
    let ruleParser: Parser<Node, Token> = grammar[rule];
    if (!ruleParser) throw debug(`invalid rule name: ${rule}`);
    let potentialAsts: PartialAst<Node, Token>[] = [{ rule: ruleParser }] as any;
    for (const token of tokens) {
        const errors: ExpectedToken<Token> = { expected: [] };
        const partials: PartialAst<Node, Token>[] = [];
        for (const potentialAst of potentialAsts) {
            const { errors: newErrors, partials: newPartials } = applyTokenToPartialParse(
                grammar,
                potentialAst,
                token
            );
            partials.push(...newPartials);
            for (const newError in newErrors.expected) {
                errors.expected.push(newError as Token);
            }
        }
        if (partials.length == 0) {
            // NOTE: Just here for easy rerun while debugging
            for (const potentialAst of potentialAsts) {
                const { errors: newErrors, partials: newPartials } = applyTokenToPartialParse(
                    grammar,
                    potentialAst,
                    token
                );
                partials.push(...newPartials);
                for (const newError in newErrors.expected) {
                    errors.expected.push(newError as Token);
                }
            }
            return {
                kind: 'parseError',
                errors: errors.expected.map(expectedToken => {
                    return {
                        expected: expectedToken,
                        found: token.string,
                        foundTokenText: `${token}`,
                        sourceLocation: token.sourceLocation,
                        whileParsing: [rule],
                    };
                }) as unknown as ParseFailureInfo<Token>[],
            };
        }
        potentialAsts = partials;
    }
    const completeAsts: PartialAst<Node, Token>[] = [];
    const incompleteAsts: PartialAst<Node, Token>[] = [];
    drain(potentialAsts, ast => {
        const rule = getRuleForNextEmptySlot(ast);
        if (!rule) {
            completeAsts.push(ast);
            return;
        }
        const newAsts = getPotentialAsts(grammar, rule, 'endOfFile');
        if ('expected' in newAsts) {
            incompleteAsts.push(ast);
            return;
        }
        for (const newAst of newAsts) {
            const extended = deepCopy(ast);
            replaceRuleForNextEmptySlotWithPartial(extended, newAst.partial);
            potentialAsts.push(extended);
        }
    });
    if (completeAsts.length > 1) {
        // TODO:TAC parser contains some real ambiguities (loadImmediate vs assign when data is a number)
        // but by coincidence, the first parse is the correct one, so for the tac parser, skip this check
        if (!('global' in grammar)) {
            throw debug('ambiguous parse');
        }
    }
    if (completeAsts.length < 1) {
        // TODO: give good error about extra tokens
        throw debug('no parse');
    }
    return stripResultIndexes(partialAstToCompleteAst(completeAsts[0]));
};

export const parse = <Node extends string, Token>(
    grammar: Grammar<Node, Token>,
    firstRule: Node,
    tokens: LToken<Token>[]
): ParseResult<Node, Token> => {
    const result = parseRule(grammar, firstRule, tokens, 0);
    if (parseResultIsError(result)) return result;
    if (result.newIndex != tokens.length) {
        const firstExtraToken = tokens[result.newIndex];
        if (!firstExtraToken) debug('there are extra tokens but also not');
        return {
            kind: 'parseError',
            errors: [
                {
                    found: firstExtraToken.type,
                    foundTokenText: firstExtraToken.string,
                    expected: 'endOfFile',
                    whileParsing: [firstRule],
                    sourceLocation: firstExtraToken.sourceLocation,
                },
            ],
        };
    }
    return parseRule2(grammar, firstRule, tokens);
};

export const parseString = <Node extends string, Token>(
    tokens: TokenSpec<Token>[],
    grammar: Grammar<Node, Token>,
    rule: any,
    input: string
): ParseResult<Node, Token> | { errors: LexError | ParseFailureInfo<Token>[] } => {
    const lexed = lex(tokens, input);
    if ('kind' in lexed) return { errors: lexed };
    const parsed = parse(grammar, rule, lexed);
    if (parseResultIsError(parsed)) {
        return { errors: parsed.errors };
    }
    return parsed;
};
