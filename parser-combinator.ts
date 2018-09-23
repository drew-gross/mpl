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
    sourceLocation: SourceLocation;
}

type Leaf<TokenType> = {
    type: TokenType | 'endOfFile';
    value: string | number | null | undefined;
    sourceLocation: SourceLocation;
};

type Ast<NodeType, LeafType> = Node<NodeType, LeafType> | Leaf<LeafType>;

interface LeafWithIndex<TokenType> {
    success: true;
    newIndex: number;
    type: TokenType | 'endOfFile';
    value: string | number | null | undefined;
    sourceLocation: SourceLocation;
}

interface NodeWithIndex<NodeType, LeafType> {
    success: true;
    newIndex: number;
    type: NodeType;
    children: AstWithIndex<NodeType, LeafType>[];
    sourceLocation: SourceLocation;
}

type AstWithIndex<NodeType, TokenType> = NodeWithIndex<NodeType, TokenType> | LeafWithIndex<TokenType>;

interface ParseFailureInfo<TokenType> {
    found: TokenType | 'endOfFile';
    expected: TokenType | 'endOfFile';
    sourceLocation: SourceLocation;
}

type ParseError<TokenType> = { kind: 'parseError'; errors: ParseFailureInfo<TokenType>[] };

type ParseResultWithIndex<NodeType, TokenType> = ParseError<TokenType> | AstWithIndex<NodeType, TokenType>;
type ParseResult<NodeType, TokenType> = ParseError<TokenType> | Ast<NodeType, TokenType>;

const parseResultIsError = <NodeType, LeafType, TokenType>(
    result:
        | ParseResult<NodeType, TokenType>
        | ParseResultWithIndex<NodeType, TokenType>
        | AstWithIndex<NodeType, LeafType>[]
        | 'missingOptional'
): result is ParseError<TokenType> => result != 'missingOptional' && 'kind' in result && result.kind == 'parseError';

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
            sourceLocation: r.sourceLocation,
        };
    }
    return {
        type: r.type,
        children: r.children.map(stripNodeIndexes),
        sourceLocation: r.sourceLocation,
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

type EndOfInput = { kind: 'endOfInput' };
type Terminal<NodeType, TokenType> = { kind: 'terminal'; tokenType: TokenType } | EndOfInput;
type BaseParser<NodeType, TokenType> = string | Terminal<NodeType, TokenType>;
type Sequence<NodeType, TokenType> = { kind: 'sequence'; name: string; parsers: Parser<NodeType, TokenType>[] };
type Alternative<NodeType, TokenType> = { kind: 'oneOf'; parsers: Parser<NodeType, TokenType>[] };
type Optional<NodeType, TokenType> = { kind: 'optional'; parser: Parser<NodeType, TokenType> };

type Parser<NodeType, TokenType> =
    | Alternative<NodeType, TokenType>
    | Sequence<NodeType, TokenType>
    | BaseParser<NodeType, TokenType>
    | Optional<NodeType, TokenType>;

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

export const Optional = <NodeType, TokenType>(parser: Parser<NodeType, TokenType>): Optional<NodeType, TokenType> => ({
    kind: 'optional',
    parser,
});

export interface Grammar<NodeType, TokenType> {
    // Ideally would have NodeType instead of string here but typescript doesn't allow that.
    [index: string]: Parser<NodeType, TokenType>;
}

const getSourceLocation = <TokenType>(tokens: Token<TokenType>[], index: number): SourceLocation => {
    if (index >= tokens.length) {
        const lastToken: Token<TokenType> = last(tokens) as Token<TokenType>;
        return {
            line: lastToken.sourceLocation.line,
            column: lastToken.sourceLocation.column + lastToken.string.length,
        };
    } else {
        return tokens[index].sourceLocation;
    }
};

const isTerminalParser = <NodeType, TokenType>(p: Parser<NodeType, TokenType>): p is Terminal<NodeType, TokenType> =>
    typeof p == 'object' && 'kind' in p && (p.kind === 'terminal' || p.kind == 'endOfInput');

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
        if (isTerminalParser(p)) {
            result = parseTerminal(p, tokens, index);
        } else if (typeof p === 'string') {
            result = parse(grammar, p as NodeType, tokens, index);
        } else {
            throw debug('Sequence of sequences');
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
        sourceLocation: getSourceLocation(tokens, originalIndex),
    };
    return result;
};

type ParserProgress<NodeType, TokenType> =
    | { kind: 'failed'; error: ParseError<TokenType> }
    | { kind: 'progress'; parseResults: AstWithIndex<NodeType, TokenType>[]; subParserIndex: number };

const parseAlternative = <NodeType extends string, TokenType>(
    grammar: Grammar<NodeType, TokenType>,
    alternatives: Alternative<NodeType, TokenType>,
    tokens: Token<TokenType>[],
    index: number
): ParseResultWithIndex<NodeType, TokenType> => {
    const alternativeIndex: number = 0;
    const progressCache: ParserProgress<NodeType, TokenType>[] = alternatives.parsers.map(
        _ =>
            ({
                kind: 'progress',
                parseResults: [],
                subParserIndex: 0,
            } as ParserProgress<NodeType, TokenType>)
    );
    for (let alternativeIndex = 0; alternativeIndex < alternatives.parsers.length; alternativeIndex++) {
        let alternativeNeedsSubtracting = false;
        let currentParser = alternatives.parsers[alternativeIndex];
        let currentResult: ParseResultWithIndex<NodeType, TokenType> | 'missingOptional';
        let currentResultIsMissingOptional = false;
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
        } else if (currentParser.kind == 'sequence') {
            // Sequence. This is the complex one.

            // Next get the parser for the next item in the sequence based on how much progress we have made due
            // to being a prefix of previous rules.
            const sequenceParser = currentParser;
            currentParser = currentParser.parsers[currentProgress.subParserIndex];

            const currentProgressLastItem = last(currentProgress.parseResults);
            const tokenIndex = currentProgressLastItem !== null ? currentProgressLastItem.newIndex : index;
            // Check if this parser has been completed due to being a successful prefix of a previous alternative
            if (currentProgressLastItem !== null && currentProgress.subParserIndex === sequenceParser.parsers.length) {
                return {
                    newIndex: currentProgressLastItem.newIndex,
                    success: true,
                    children: currentProgress.parseResults,
                    type: sequenceParser.name as NodeType,
                    sourceLocation: getSourceLocation(tokens, index),
                };
            }

            // We still need to do work on this parser
            if (isTerminalParser(currentParser)) {
                currentResult = parseTerminal(currentParser, tokens, tokenIndex);
                currentIndex = currentProgress.subParserIndex;
            } else if (typeof currentParser == 'string') {
                currentResult = parse(grammar, currentParser as NodeType, tokens, tokenIndex);
                currentIndex = currentProgress.subParserIndex;
            } else if (currentParser.kind == 'optional') {
                const optionalResult = parseOptional(grammar, currentParser, tokens, tokenIndex);
                if (optionalResult === undefined) {
                    currentResult = 'missingOptional';
                } else {
                    currentResult = optionalResult;
                }
                currentIndex = currentProgress.subParserIndex;
            } else {
                throw debug('unhandled kind of parser');
            }

            // Push the results into the cache for the current parser
            if (parseResultIsError(currentResult)) {
                progressCache[alternativeIndex] = { kind: 'failed', error: currentResult };
            } else {
                if (progressCache[alternativeIndex].kind != 'failed') {
                    if (currentResult !== 'missingOptional') {
                        (progressCache[alternativeIndex] as any).parseResults.push(currentResult);
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
                return {
                    newIndex: cachedSuccess.newIndex,
                    success: true,
                    children: refreshedCurrentProgress.parseResults,
                    type: sequenceParser.name as NodeType,
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
                        progressCache[progressCacheIndex] = { kind: 'failed', error: currentResult };
                    } else if (currentResult != 'missingOptional') {
                        progressRef.parseResults.push(currentResult);
                        progressRef.subParserIndex++;
                    }
                } else if (typeof parser === 'function' && currentParser == parser) {
                    if (parseResultIsError(currentResult)) {
                        progressCache[progressCacheIndex] = { kind: 'failed', error: currentResult };
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
                        progressCache[progressCacheIndex] = { kind: 'failed', error: currentResult };
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
                    if (currentResult != 'missingOptional' && !parseResultIsError(currentResult)) {
                        (progressCache[progressCacheIndex] as any).parseResults.push(currentResult);
                    }
                    (progressCache[progressCacheIndex] as any).subParserIndex++;
                }
            }
        }

        if (alternativeNeedsSubtracting) {
            alternativeIndex--;
        }
    }

    const errors: ParseError<TokenType> = { kind: 'parseError', errors: [] };
    progressCache.forEach(progress => {
        if (progress.kind == 'failed') {
            errors.errors.push(...progress.error.errors);
        } else {
            throw debug('everything should have failed by now');
        }
    });
    return errors;
};

const parseAnything = <NodeType extends string, TokenType>(
    grammar: Grammar<NodeType, TokenType>,
    parser: Parser<NodeType, TokenType>,
    tokens: Token<TokenType>[],
    index: number
): ParseResultWithIndex<NodeType, TokenType> => {
    if (typeof parser === 'string') {
        return parse(grammar, parser as NodeType, tokens, index);
    } else if (isTerminalParser(parser)) {
        return parseTerminal(parser, tokens, index);
    } else if (parser.kind == 'sequence') {
        return parseSequence(grammar, parser, tokens, index);
    } else if (parser.kind == 'oneOf') {
        return parseAlternative(grammar, parser, tokens, index);
    } else {
        throw debug('bad type in parse');
    }
};

const parseOptional = <NodeType extends string, TokenType>(
    grammar: Grammar<NodeType, TokenType>,
    optional: Optional<NodeType, TokenType>,
    tokens: Token<TokenType>[],
    index: number
): ParseResultWithIndex<NodeType, TokenType> | undefined => {
    const result = parseAnything(grammar, optional.parser, tokens, index);
    if (parseResultIsError(result)) {
        return undefined;
    }
    return result;
};

export const parse = <NodeType extends string, TokenType>(
    grammar: Grammar<NodeType, TokenType>,
    firstRule: NodeType,
    tokens: Token<TokenType>[],
    index: number
): ParseResultWithIndex<NodeType, TokenType> => {
    const childrenParser: Parser<NodeType, TokenType> = grammar[firstRule];
    if (!childrenParser) throw debug('!childrenParser in parse');
    return parseAnything(grammar, childrenParser, tokens, index);
};

const parseTerminal = <NodeType, TokenType>(
    terminal: Terminal<NodeType, TokenType>,
    tokens: Token<TokenType>[],
    index
): ParseResultWithIndex<NodeType, TokenType> => {
    if (terminal.kind == 'endOfInput') {
        if (index == tokens.length) {
            return {
                success: true,
                newIndex: index + 1,
                value: 'endOfFile',
                type: 'endOfFile',
                sourceLocation: getSourceLocation(tokens, index),
            };
        } else {
            return {
                kind: 'parseError',
                errors: [
                    {
                        found: tokens[index].type,
                        expected: 'endOfFile',
                        sourceLocation: getSourceLocation(tokens, index),
                    },
                ],
            };
        }
    }
    if (index >= tokens.length) {
        return {
            kind: 'parseError',
            errors: [
                {
                    found: 'endOfFile',
                    expected: terminal.tokenType,
                    sourceLocation: getSourceLocation(tokens, index),
                },
            ],
        };
    }
    if (tokens[index].type == terminal.tokenType) {
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
                expected: terminal.tokenType,
                found: tokens[index].type,
                sourceLocation: getSourceLocation(tokens, index),
            },
        ],
    };
};

const Terminal = <NodeType, TokenType>(token: TokenType): Terminal<NodeType, TokenType> => ({
    kind: 'terminal',
    tokenType: token,
});

const endOfInput: EndOfInput = { kind: 'endOfInput' };

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
    Terminal,
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
