import { Token } from './lex.js';
import unique from '../util/list/unique.js';
import flatten from '../util/list/flatten.js';
import last from '../util/list/last.js';
import debug from '../util/debug.js';
import { Graph } from 'graphlib';
import SourceLocation from './sourceLocation.js';

interface Node<NodeType, LeafType, ActionResult> {
    type: NodeType;
    children: Ast<NodeType, LeafType, ActionResult>[];
    sourceLocation: SourceLocation;
}

export type Leaf<TokenType, ActionResult> = {
    type: TokenType | 'endOfFile';
    value: ActionResult | undefined;
    sourceLocation: SourceLocation;
};

export type Ast<NodeType, LeafType, ActionResult> =
    | Node<NodeType, LeafType, ActionResult>
    | Leaf<LeafType, ActionResult>;

interface LeafWithIndex<TokenType, ActionResult> {
    success: true;
    newIndex: number;
    type: TokenType | 'endOfFile';
    value: ActionResult | undefined;
    sourceLocation: SourceLocation;
}

interface NodeWithIndex<NodeType, LeafType, ActionResult> {
    success: true;
    newIndex: number;
    type: NodeType;
    children: AstWithIndex<NodeType, LeafType, ActionResult>[];
    sourceLocation: SourceLocation;
}

export type AstWithIndex<NodeType, TokenType, ActionResult> =
    | NodeWithIndex<NodeType, TokenType, ActionResult>
    | LeafWithIndex<TokenType, ActionResult>;

// TODO: just put the actual token in here instead of most of it's members
export interface ParseFailureInfo<TokenType> {
    found: TokenType | 'endOfFile';
    foundTokenText: string;
    expected: TokenType | 'endOfFile';
    whileParsing: string[];
    sourceLocation: SourceLocation;
}

export type ParseError<TokenType> = { kind: 'parseError'; errors: ParseFailureInfo<TokenType>[] };

export type ParseResultWithIndex<NodeType, TokenType, ActionResult> =
    | ParseError<TokenType>
    | AstWithIndex<NodeType, TokenType, ActionResult>;
export type ParseResult<NodeType, TokenType, ActionResult> =
    | ParseError<TokenType>
    | Ast<NodeType, TokenType, ActionResult>;

export const parseResultIsError = <NodeType, LeafType, TokenType, ActionResult>(
    result:
        | ParseResult<NodeType, TokenType, ActionResult>
        | ParseResultWithIndex<NodeType, TokenType, ActionResult>
        | AstWithIndex<NodeType, LeafType, ActionResult>[]
        | 'missingOptional'
): result is ParseError<TokenType> => result != 'missingOptional' && 'kind' in result && result.kind == 'parseError';

const parseResultWithIndexIsLeaf = <NodeType, TokenType, ActionResult>(
    r: ParseResultWithIndex<NodeType, TokenType, ActionResult>
): r is LeafWithIndex<TokenType, ActionResult> => {
    if (!r) throw debug('!r');
    return 'value' in r;
};

const stripNodeIndexes = <NodeType, AstLeafNodeType, ActionResult>(
    r: AstWithIndex<NodeType, AstLeafNodeType, ActionResult>
): Ast<NodeType, AstLeafNodeType, ActionResult> => {
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

export const stripResultIndexes = <NodeType, TokenType, ActionResult>(
    r: ParseResultWithIndex<NodeType, TokenType, ActionResult>
): ParseResult<NodeType, TokenType, ActionResult> => {
    if (parseResultIsError(r)) {
        return r;
    }
    return stripNodeIndexes(r);
};

export const stripSourceLocation = ast => {
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

type Terminal<NodeType, TokenType> = { kind: 'terminal'; tokenType: TokenType };
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

const getSourceLocation = <TokenType, ActionResult>(
    tokens: Token<TokenType, ActionResult>[],
    index: number
): SourceLocation => {
    if (index >= tokens.length) {
        const lastToken: Token<TokenType, ActionResult> = last(tokens) as Token<TokenType, ActionResult>;
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

const isTerminalParser = <NodeType, TokenType>(p: Parser<NodeType, TokenType>): p is Terminal<NodeType, TokenType> =>
    typeof p == 'object' && 'kind' in p && p.kind === 'terminal';

const parseSequence = <NodeType extends string, TokenType, ActionResult>(
    grammar: Grammar<NodeType, TokenType>,
    parser: Sequence<NodeType, TokenType>,
    tokens: Token<TokenType, ActionResult>[],
    index: number
): ParseResultWithIndex<NodeType, TokenType, ActionResult> => {
    const originalIndex = index;
    const results: AstWithIndex<NodeType, TokenType, ActionResult>[] = [];
    for (const p of parser.parsers) {
        let result: ParseResultWithIndex<NodeType, TokenType, ActionResult>;
        if (isTerminalParser(p)) {
            result = parseTerminal(p, tokens, index);
        } else if (typeof p === 'string') {
            result = parseRule(grammar, p as NodeType, tokens, index);
        } else if (p.kind == 'optional') {
            const maybeResult = parseOptional(grammar, p, tokens, index);
            if (!maybeResult) {
                continue; // Skip to the next non-optional
            } else {
                result = maybeResult;
            }
        } else {
            throw debug(`Sequence of sequences: ${JSON.stringify(p)}`);
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
        type: parser.name as NodeType,
        children: results,
        sourceLocation: getSourceLocation(tokens, originalIndex),
    };
};

type ParserProgress<NodeType, TokenType, ActionResult> =
    | { kind: 'failed'; error: ParseError<TokenType> }
    | { kind: 'progress'; parseResults: AstWithIndex<NodeType, TokenType, ActionResult>[]; subParserIndex: number };

const parseAlternative = <NodeType extends string, TokenType, ActionResult>(
    grammar: Grammar<NodeType, TokenType>,
    alternatives: Alternative<NodeType, TokenType>,
    tokens: Token<TokenType, ActionResult>[],
    index: number
): ParseResultWithIndex<NodeType, TokenType, ActionResult> => {
    const alternativeIndex: number = 0;
    const progressCache: ParserProgress<NodeType, TokenType, ActionResult>[] = alternatives.parsers.map(
        _ =>
            ({
                kind: 'progress',
                parseResults: [],
                subParserIndex: 0,
            } as ParserProgress<NodeType, TokenType, ActionResult>)
    );

    // TODO: fix this linter error
    // tslint:disable-next-line
    for (let alternativeIndex = 0; alternativeIndex < alternatives.parsers.length; alternativeIndex++) {
        let alternativeNeedsSubtracting = false;
        let currentParser = alternatives.parsers[alternativeIndex];
        let currentResult: ParseResultWithIndex<NodeType, TokenType, ActionResult> | 'missingOptional';
        const currentResultIsMissingOptional = false;
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
                currentResult = parseRule(grammar, currentParser as NodeType, tokens, tokenIndex);
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
                throw debug(`unhandled kind of parser: ${currentParser.kind}`);
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
    errors.errors.sort((l, r) => {
        if (l.sourceLocation.line != r.sourceLocation.line) {
            return r.sourceLocation.line - l.sourceLocation.line;
        }
        return r.sourceLocation.column - l.sourceLocation.column;
    });
    return errors;
};

const parseAnything = <NodeType extends string, TokenType, ActionResult>(
    grammar: Grammar<NodeType, TokenType>,
    parser: Parser<NodeType, TokenType>,
    tokens: Token<TokenType, ActionResult>[],
    index: number
): ParseResultWithIndex<NodeType, TokenType, ActionResult> => {
    if (typeof parser === 'string') {
        return parseRule(grammar, parser as NodeType, tokens, index);
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

const parseOptional = <NodeType extends string, TokenType, ActionResult>(
    grammar: Grammar<NodeType, TokenType>,
    optional: Optional<NodeType, TokenType>,
    tokens: Token<TokenType, ActionResult>[],
    index: number
): ParseResultWithIndex<NodeType, TokenType, ActionResult> | undefined => {
    const result = parseAnything(grammar, optional.parser, tokens, index);
    if (parseResultIsError(result)) {
        return undefined;
    }
    return result;
};

const parseTerminal = <NodeType, TokenType, ActionResult>(
    terminal: Terminal<NodeType, TokenType>,
    tokens: Token<TokenType, ActionResult>[],
    index
): ParseResultWithIndex<NodeType, TokenType, ActionResult> => {
    if (index >= tokens.length) {
        return {
            kind: 'parseError',
            errors: [
                {
                    found: 'endOfFile',
                    foundTokenText: 'endOfFile',
                    expected: terminal.tokenType,
                    whileParsing: [],
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
                foundTokenText: tokens[index].string,
                whileParsing: [],
                // Use index of prevoius token so that the parse error shows up right
                // after the place where the user should have done something (e.g. they
                // place where they forgot the semicolon
                sourceLocation: getSourceLocation(tokens, index - 1),
            },
        ],
    };
};

export const Terminal = <NodeType, TokenType>(token: TokenType): Terminal<NodeType, TokenType> => ({
    kind: 'terminal',
    tokenType: token,
});

export const toDotFile = <NodeType, TokenType, ActionResult>(ast: Ast<NodeType, TokenType, ActionResult>) => {
    const digraph = new Graph();
    let id = 0;
    const traverse = (node: Ast<NodeType, TokenType, ActionResult>): number => {
        const myId = id;
        id++;
        const nodeString = 'children' in node ? node.type : `${node.type}\n${node.value ? node.value : ''}`;
        digraph.setNode(myId, { label: nodeString });
        if ('children' in node) {
            const childIds = node.children.map(traverse);
            node.children.forEach((child, index) => {
                digraph.setEdge(myId, childIds[index]);
            });
        }
        return myId;
    };
    traverse(ast);
    return digraph;
};

const parseRule = <NodeType extends string, TokenType, ActionResult>(
    grammar: Grammar<NodeType, TokenType>,
    rule: NodeType,
    tokens: Token<TokenType, ActionResult>[],
    index: number
): ParseResultWithIndex<NodeType, TokenType, ActionResult> => {
    const childrenParser: Parser<NodeType, TokenType> = grammar[rule];
    if (!childrenParser) throw debug('invalid rule name');
    return parseAnything(grammar, childrenParser, tokens, index);
};

export const parse = <NodeType extends string, TokenType, ActionResult>(
    grammar: Grammar<NodeType, TokenType>,
    firstRule: NodeType,
    tokens: Token<TokenType, ActionResult>[]
): ParseResultWithIndex<NodeType, TokenType, ActionResult> => {
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
    return result;
};
