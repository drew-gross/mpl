import { Token } from './lex.js';
import unique from './util/list/unique.js';
import flatten from './util/list/flatten.js';
import last from './util/list/last.js';
import debug from './util/debug.js';
import { Graph } from 'graphlib';
import { SourceLocation } from './api.js';

interface Node<NodeType, LeafType> {
    type: NodeType;
    children: Ast<NodeType, LeafType>[];
}

type Leaf<TokenType> = {
    type: TokenType | 'endOfFile';
    value: string | number | null | undefined;
};

type Ast<NodeType, LeafType> = (Node<NodeType, LeafType> | Leaf<LeafType>) & SourceLocation;

interface LeafWithIndex<TokenType> {
    success: true;
    newIndex: number;
    type: TokenType | 'endOfFile';
    value: string | number | null | undefined;
    sourceLine: number;
    sourceColumn: number;
}

interface NodeWithIndex<NodeType, LeafType> {
    success: true;
    newIndex: number;
    type: NodeType;
    children: AstWithIndex<NodeType, LeafType>[];
    sourceLine: number;
    sourceColumn: number;
}

type AstWithIndex<NodeType, TokenType> = (NodeWithIndex<NodeType, TokenType> | LeafWithIndex<TokenType>) &
    SourceLocation;

interface ParseError<TokenType> {
    found: (TokenType | 'endOfFile')[];
    expected: (TokenType | 'endOfFile')[];
    sourceLine: number;
    sourceColumn: number;
}

type ParseResultWithIndex<NodeType, TokenType> = ParseError<TokenType> | AstWithIndex<NodeType, TokenType>;
type ParseResult<NodeType, TokenType> = ParseError<TokenType> | Ast<NodeType, TokenType>;

const parseResultIsError = <NodeType, LeafType, TokenType>(
    result:
        | ParseResult<NodeType, TokenType>
        | ParseResultWithIndex<NodeType, TokenType>
        | AstWithIndex<NodeType, LeafType>[]
): result is ParseError<TokenType> => {
    if (!result) throw debug('!result');
    return 'found' in result && 'expected' in result;
};
const parseResultWithIndexIsLeaf = <NodeType, TokenType>(
    r: ParseResultWithIndex<NodeType, TokenType>
): r is LeafWithIndex<TokenType> => {
    if (!r) throw debug('!r');
    return 'value' in r;
};

const stripNodeIndexes = <NodeType, AstLeafNodeType>(
    r: AstWithIndex<NodeType, AstLeafNodeType>
): Ast<NodeType, AstLeafNodeType> => {
    if (parseResultWithIndexIsLeaf(r)) {
        return {
            value: r.value,
            type: r.type,
            sourceLine: r.sourceLine,
            sourceColumn: r.sourceColumn,
        };
    }
    return {
        type: r.type,
        children: r.children.map(stripNodeIndexes),
        sourceLine: r.sourceLine,
        sourceColumn: r.sourceColumn,
    };
};

const stripResultIndexes = <NodeType, TokenType>(
    r: ParseResultWithIndex<NodeType, TokenType>
): ParseResult<NodeType, TokenType> => {
    if (parseResultIsError(r)) {
        return r;
    }
    return stripNodeIndexes(r);
};

const stripSourceLocation = ast => {
    if ('children' in ast) {
        return {
            type: ast.type,
            children: ast.children.map(stripSourceLocation),
        };
    } else {
        return {
            type: ast.type,
            value: ast.value,
        };
    }
};

type BaseParser<NodeType, TokenType> = string | Terminal<NodeType, TokenType>;

export type Terminal<NodeType, TokenType> = (
    tokens: Token<TokenType>[],
    index: number
) => ParseResultWithIndex<NodeType, TokenType>;

type Sequence<NodeType, TokenType> = { kind: 'sequence'; name: string; parsers: Parser<NodeType, TokenType>[] };
type Alternative<NodeType, TokenType> = { kind: 'oneOf'; parsers: Parser<NodeType, TokenType>[] };

type Parser<NodeType, TokenType> =
    | Alternative<NodeType, TokenType>
    | Sequence<NodeType, TokenType>
    | BaseParser<NodeType, TokenType>;

export const Sequence = <NodeType extends string, TokenType>(
    name: NodeType,
    parsers: Parser<NodeType, TokenType>[]
): Sequence<NodeType, TokenType> => ({
    kind: 'sequence',
    name,
    parsers,
});

export const OneOf = <NodeType, TokenType>(
    parsers: Parser<NodeType, TokenType>[]
): Alternative<NodeType, TokenType> => ({
    kind: 'oneOf',
    parsers,
});

export interface Grammar<NodeType, TokenType> {
    // Ideally would have NodeType instead of string here but typescript doesn't allow that.
    [index: string]: Parser<NodeType, TokenType>;
}

const getSourceLocation = <TokenType>(tokens: Token<TokenType>[], index: number): SourceLocation => {
    if (index >= tokens.length) {
        const lastToken: Token<TokenType> = last(tokens) as Token<TokenType>;
        return {
            sourceLine: lastToken.sourceLine,
            sourceColumn: lastToken.sourceColumn + lastToken.string.length,
        };
    } else {
        const token: Token<TokenType> = tokens[index];
        return { sourceLine: token.sourceLine, sourceColumn: token.sourceColumn };
    }
};

const parseSequence = <NodeType extends string, TokenType>(
    grammar: Grammar<NodeType, TokenType>,
    parser: Sequence<NodeType, TokenType>,
    tokens: Token<TokenType>[],
    index: number
): ParseResultWithIndex<NodeType, TokenType> => {
    const originalIndex = index;
    const results: AstWithIndex<NodeType, TokenType>[] = [];
    for (const p of parser.parsers) {
        let result: ParseResultWithIndex<NodeType, TokenType>;
        if (typeof p === 'function') {
            result = p(tokens, index);
        } else if (typeof p === 'string') {
            result = parse(grammar, p as NodeType, tokens, index);
        } else {
            throw debug("I feel like we shouldn't get here");
        }

        if (parseResultIsError(result)) {
            return result;
        }

        results.push(result);
        index = result.newIndex;
    }
    const result: NodeWithIndex<NodeType, TokenType> = {
        success: true,
        newIndex: index,
        type: parser.name as NodeType,
        children: results,
        ...getSourceLocation(tokens, originalIndex),
    };
    return result;
};

const parseAlternative = <NodeType extends string, TokenType>(
    grammar: Grammar<NodeType, TokenType>,
    alternatives: Alternative<NodeType, TokenType>,
    tokens: Token<TokenType>[],
    index: number
): ParseResultWithIndex<NodeType, TokenType> => {
    const alternativeIndex: number = 0;
    const progressCache: (ParseError<TokenType> | AstWithIndex<NodeType, TokenType>[])[] = alternatives.parsers.map(
        _ => []
    );
    for (let alternativeIndex = 0; alternativeIndex < alternatives.parsers.length; alternativeIndex++) {
        let alternativeNeedsSubtracting = false;
        let currentParser = alternatives.parsers[alternativeIndex];
        const currentProgressRef: ParseError<TokenType> | AstWithIndex<NodeType, TokenType>[] =
            progressCache[alternativeIndex];
        let currentResult: ParseResultWithIndex<NodeType, TokenType>;
        let currentIndex: number;

        // Check if we have cached an error for this parser. If we have, continue to the next parser.
        if (parseResultIsError(currentProgressRef)) {
            continue;
        }
        if (!currentParser) throw debug('no currentParser');

        if (typeof currentParser === 'string') {
            // Reference to another rule.
            if (currentProgressRef.length == 1) {
                // We already finished this one earlier. It must be a prefix of an earlier rule.
                return currentProgressRef[0];
            } else {
                // We haven't tried this parser yet. Try it now.
                currentResult = parse(grammar, currentParser as NodeType, tokens, index);
                currentIndex = 0;
                if (!parseResultIsError(currentResult)) {
                    return currentResult;
                }
            }
        } else if (typeof currentParser === 'function') {
            // Terminal.
            if (currentProgressRef.length == 1) {
                // We already finished this one earlier. It must be a prefix of an earlier rule.
                return currentProgressRef[0];
            } else {
                // We haven't tried this parser yet. Try it now.
                currentResult = currentParser(tokens, index);
                currentIndex = 0;
                if (!parseResultIsError(currentResult)) {
                    return currentResult;
                }
            }
        } else if (currentParser.kind == 'sequence') {
            // Sequence. This is the complex one.

            // Next get the parser for the next item in the sequence based on how much progress we have made due
            // to being a prefix of previous rules.
            const sequence = currentParser;
            currentParser = currentParser.parsers[currentProgressRef.length];

            const currentProgressLastItem = last(currentProgressRef);
            const tokenIndex = currentProgressLastItem !== null ? currentProgressLastItem.newIndex : index;
            // Check if this parser has been completed due to being a successful prefix of a previous alternative
            if (
                currentProgressLastItem !== null &&
                !parseResultIsError(currentProgressLastItem) &&
                currentProgressRef.length === sequence.parsers.length
            ) {
                const result: AstWithIndex<NodeType, TokenType> = {
                    newIndex: currentProgressLastItem.newIndex,
                    success: true,
                    children: currentProgressRef,
                    type: sequence.name as NodeType,
                    ...getSourceLocation(tokens, index),
                };
                return result;
            }

            // Try the parser
            if (typeof currentParser === 'function') {
                currentResult = currentParser(tokens, tokenIndex);
                currentIndex = currentProgressRef.length;
            } else {
                currentResult = parse(grammar, currentParser as NodeType, tokens, tokenIndex);
                currentIndex = currentProgressRef.length;
            }

            // Push the results into the cache for the current parser
            if (parseResultIsError(currentResult)) {
                progressCache[alternativeIndex] = currentResult;
            } else {
                currentProgressRef.push(currentResult);

                // When we return to the top of this loop, we want to continue parsing the current sequence.
                // In order to make this happen, flag that we need to subtract one from alternativesIndex.
                // TODO: Be less janky.
                alternativeNeedsSubtracting = true;
            }

            // Check if we are done
            if (!parseResultIsError(currentResult) && currentProgressRef.length == sequence.parsers.length) {
                const cachedSuccess = last(currentProgressRef);
                if (cachedSuccess === null) throw debug('cachedSuccess == null');
                const result: AstWithIndex<NodeType, TokenType> = {
                    newIndex: cachedSuccess.newIndex,
                    success: true,
                    children: currentProgressRef,
                    type: sequence.name as NodeType,
                    ...getSourceLocation(tokens, index),
                };
                return result;
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
            if (!parseResultIsError(progressRef) && progressRef.length == currentIndex) {
                if (typeof parser === 'string' && currentParser == parser) {
                    if (parseResultIsError(currentResult)) {
                        progressCache[alternativeIndex] = currentResult;
                    } else {
                        progressRef.push(currentResult);
                    }
                } else if (typeof parser === 'function' && currentParser == parser) {
                    if (parseResultIsError(currentResult)) {
                        progressCache[alternativeIndex] = currentResult;
                    } else {
                        progressRef.push(currentResult);
                    }
                } else if (
                    typeof parser != 'string' &&
                    typeof parser != 'function' &&
                    parser.kind == 'sequence' &&
                    currentParser === parser.parsers[currentIndex]
                ) {
                    if (parseResultIsError(currentResult)) {
                        progressCache[alternativeIndex] = currentResult;
                    } else {
                        progressRef.push(currentResult);
                    }
                }
            }
        }

        if (alternativeNeedsSubtracting) {
            alternativeIndex--;
        }
    }

    progressCache.map((error: ParseError<TokenType> | AstWithIndex<NodeType, TokenType>[]) => {
        if (!parseResultIsError(error)) {
            parseAlternative(grammar, alternatives, tokens, index);
            throw debug('Didnt finish implmenting this maybe?');
        }
        return error.found;
    });
    return {
        found: unique(
            flatten(
                progressCache.map(error => {
                    if (!parseResultIsError(error)) throw debug('!parseResultIsError in parseAlternative');
                    return error.found;
                })
            )
        ),
        expected: unique(
            flatten(
                progressCache.map(error => {
                    if (!parseResultIsError(error)) throw debug('!parseResultIsError in parseAlternative');
                    return error.expected;
                })
            )
        ),
        ...getSourceLocation(tokens, index),
    };
};

export const parse = <NodeType extends string, TokenType>(
    grammar: Grammar<NodeType, TokenType>,
    firstRule: NodeType,
    tokens: Token<TokenType>[],
    index: number
): ParseResultWithIndex<NodeType, TokenType> => {
    const childrenParser: Parser<NodeType, TokenType> = grammar[firstRule];
    if (!childrenParser) throw debug('!childrenParser in parse');
    if (typeof childrenParser === 'string') {
        throw debug('maybe this is unused');
        // return parse(childrenParser, firstRule as NodeType, tokens, index);
    } else if (typeof childrenParser === 'function') {
        throw debug('think this is unused');
    } else if (childrenParser.kind == 'sequence') {
        return parseSequence(grammar, childrenParser, tokens, index);
    } else if (childrenParser.kind == 'oneOf') {
        return parseAlternative(grammar, childrenParser, tokens, index);
    } else {
        throw debug('bad type in parse');
    }
};

const terminal = <NodeType, TokenType>(terminal: TokenType): Terminal<NodeType, TokenType> => (
    tokens: Token<TokenType>[],
    index
): ParseResultWithIndex<NodeType, TokenType> => {
    if (index >= tokens.length) {
        const result: ParseError<TokenType> = {
            found: ['endOfFile'],
            expected: [terminal],
            ...getSourceLocation(tokens, index),
        };
        return result;
    }
    if (tokens[index].type == terminal) {
        return {
            success: true,
            newIndex: index + 1,
            value: tokens[index].value,
            type: tokens[index].type,
            ...getSourceLocation(tokens, index),
        };
    }

    return {
        expected: [terminal],
        found: [tokens[index].type],
        ...getSourceLocation(tokens, index),
    };
};

const endOfInput = <NodeType, TokenType>(
    tokens: Token<TokenType>[],
    index: number
): ParseResultWithIndex<NodeType, TokenType> => {
    if (index == tokens.length) {
        return {
            success: true,
            newIndex: index + 1,
            value: 'endOfFile',
            type: 'endOfFile',
            ...getSourceLocation(tokens, index),
        };
    } else {
        return {
            expected: ['endOfFile'],
            found: [tokens[index].type],
            ...getSourceLocation(tokens, index),
        };
    }
};

const toDotFile = <NodeType, TokenType>(ast: Ast<NodeType, TokenType>) => {
    const digraph = new Graph();
    let id = 0;
    const traverse = (ast: Ast<NodeType, TokenType>): number => {
        let myId = id;
        id++;
        const nodeString = 'children' in ast ? ast.type : `${ast.type}\n${ast.value ? ast.value : ''}`;
        digraph.setNode(myId, { label: nodeString });
        if ('children' in ast) {
            const childIds = ast.children.map(traverse);
            ast.children.forEach((child, index) => {
                digraph.setEdge(myId, childIds[index]);
            });
        }
        return myId;
    };
    traverse(ast);
    return digraph;
};

export {
    terminal,
    endOfInput,
    ParseResultWithIndex,
    ParseResult,
    ParseError,
    Ast,
    AstWithIndex,
    Leaf,
    parseResultIsError,
    stripResultIndexes,
    stripSourceLocation,
    toDotFile,
};
