import { Token } from './lex.js';
import unique from './util/list/unique.js';
import flatten from './util/list/flatten.js';
import last from './util/list/last.js';
import assertNever from './util/assertNever.js';
import debug from './util/debug.js';

interface AstInteriorNode<NodeType, LeafType> {
    type: NodeType;
    children: Ast<NodeType, LeafType>[];
}

type AstLeaf<TokenType> = {
    type: TokenType | 'endOfFile';
    value: string | number | null | undefined;
};

type Ast<NodeType, LeafType> = AstInteriorNode<NodeType, LeafType> | AstLeaf<LeafType>;

interface LeafWithIndex<TokenType> {
    success: true;
    newIndex: number;
    type: TokenType | 'endOfFile';
    value: string | number | null | undefined;
}

interface NodeWithIndex<NodeType, LeafType> {
    success: true;
    newIndex: number;
    type: NodeType;
    children: AstWithIndex<NodeType, LeafType>[];
}

type AstWithIndex<NodeType, TokenType> = NodeWithIndex<NodeType, TokenType> | LeafWithIndex<TokenType>;

interface ParseError<TokenType> {
    found: (TokenType | 'endOfFile')[];
    expected: (TokenType | 'endOfFile')[];
}

type ParseResultWithIndex<NodeType, TokenType> = ParseError<TokenType> | AstWithIndex<NodeType, TokenType>;
type ParseResult<NodeType, TokenType> = ParseError<TokenType> | Ast<NodeType, TokenType>;

const parseResultIsError = <NodeType, LeafType, TokenType>(
    result:
        | ParseResult<NodeType, TokenType>
        | ParseResultWithIndex<NodeType, TokenType>
        | AstWithIndex<NodeType, LeafType>[]
): result is ParseError<TokenType> => {
    if (!result) throw debug();
    return 'found' in result && 'expected' in result;
};
const parseResultWithIndexIsLeaf = <NodeType, TokenType>(
    r: ParseResultWithIndex<NodeType, TokenType>
): r is LeafWithIndex<TokenType> => {
    if (!r) throw debug();
    return 'value' in r;
};

const stripNodeIndexes = <NodeType, AstLeafNodeType>(
    r: AstWithIndex<NodeType, AstLeafNodeType>
): Ast<NodeType, AstLeafNodeType> => {
    if (parseResultWithIndexIsLeaf(r)) {
        return {
            value: r.value,
            type: r.type,
        };
    }
    return {
        type: r.type,
        children: r.children.map(stripNodeIndexes),
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

export type BaseParser<NodeType, TokenType> = (
    tokens: Token<TokenType>[],
    index: number
) => ParseResultWithIndex<NodeType, TokenType>;
export type SequenceParser<NodeType, TokenType> = {
    n: NodeType;
    p: (string | BaseParser<NodeType, TokenType>)[];
};
type AlternativeParser<NodeType, TokenType> = (
    | SequenceParser<NodeType, TokenType>
    | string
    | BaseParser<NodeType, TokenType>)[];

export interface Grammar<NodeType, TokenType> {
    // Ideally would have NodeType instead of string here but typescript doesn't allow that.
    [index: string]:
        | SequenceParser<NodeType, TokenType>
        | SequenceParser<NodeType, TokenType>[]
        | AlternativeParser<NodeType, TokenType>;
}

const isSequence = <NodeType, TokenType>(
    val:
        | SequenceParser<NodeType, TokenType>
        | AlternativeParser<NodeType, TokenType>
        | BaseParser<NodeType, TokenType>
        | string
): val is SequenceParser<NodeType, TokenType> => {
    if (typeof val === 'string') return false;
    if (!val) throw debug();
    return 'n' in val;
};

const parseSequence = <NodeType, TokenType>(
    grammar: Grammar<NodeType, TokenType>,
    parser: SequenceParser<NodeType, TokenType>,
    tokens: Token<TokenType>[],
    index: number
): ParseResultWithIndex<NodeType, TokenType> => {
    const results: AstWithIndex<NodeType, TokenType>[] = [];
    for (const p of parser.p) {
        let result: ParseResultWithIndex<NodeType, TokenType>;
        if (typeof p === 'function') {
            result = p(tokens, index);
        } else {
            result = parse(grammar, p, tokens, index);
        }

        if (parseResultIsError(result)) {
            return result;
        }

        results.push(result);
        index = result.newIndex as number;
    }
    const result: AstWithIndex<NodeType, TokenType> = {
        success: true,
        newIndex: index,
        type: parser.n,
        children: results,
    };
    return result;
};

const parseAlternative = <NodeType, TokenType>(
    grammar: Grammar<NodeType, TokenType>,
    alternatives: AlternativeParser<NodeType, TokenType>,
    tokens: Token<TokenType>[],
    index: number
): ParseResultWithIndex<NodeType, TokenType> => {
    const alternativeIndex: number = 0;
    const progressCache: (ParseError<TokenType> | AstWithIndex<NodeType, TokenType>[])[] = alternatives.map(_ => []);
    for (let alternativeIndex = 0; alternativeIndex < alternatives.length; alternativeIndex++) {
        let alternativeNeedsSubtracting = false;
        let currentParser = alternatives[alternativeIndex];
        const currentProgressRef: ParseError<TokenType> | AstWithIndex<NodeType, TokenType>[] =
            progressCache[alternativeIndex];
        let currentResult: ParseResultWithIndex<NodeType, TokenType>;
        let currentIndex: number;

        // Check if we have cached an error for this parser. If we have, continue to the next parser.
        if (parseResultIsError(currentProgressRef)) {
            continue;
        }

        if (typeof currentParser === 'string') {
            // Reference to another rule.
            if (currentProgressRef.length == 1) {
                // We already finished this one earlier. It must be a prefix of an earlier rule.
                return currentProgressRef[0];
            } else {
                // We haven't tried this parser yet. Try it now.
                currentResult = parse(grammar, currentParser, tokens, index);
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
        } else {
            // Sequence. This is the complex one.

            // Next get the parser for the next item in the sequence based on how much progress we have made due
            // to being a prefix of previous rules.
            const sequence = currentParser;
            currentParser = currentParser.p[currentProgressRef.length];

            const currentProgressLastItem = last(currentProgressRef);
            const tokenIndex = currentProgressLastItem !== null ? currentProgressLastItem.newIndex : index;
            // Check if this parser has been completed due to being a successful prefix of a previous alternative
            if (
                currentProgressLastItem !== null &&
                !parseResultIsError(currentProgressLastItem) &&
                currentProgressRef.length === sequence.p.length
            ) {
                const result: AstWithIndex<NodeType, TokenType> = {
                    newIndex: currentProgressLastItem.newIndex,
                    success: true,
                    children: currentProgressRef,
                    type: sequence.n,
                };
                return result;
            }

            // Try the parser
            if (typeof currentParser === 'function') {
                currentResult = currentParser(tokens, tokenIndex);
                currentIndex = currentProgressRef.length;
            } else {
                currentResult = parse(grammar, currentParser, tokens, tokenIndex);
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
            if (!parseResultIsError(currentResult) && currentProgressRef.length == sequence.p.length) {
                const cachedSuccess = last(currentProgressRef);
                if (cachedSuccess === null) throw debug();
                const result: AstWithIndex<NodeType, TokenType> = {
                    newIndex: cachedSuccess.newIndex,
                    success: true,
                    children: currentProgressRef,
                    type: sequence.n,
                };
                return result;
            }
        }

        // Now we have a parse result and the index it was found at. Push it into the progress cache
        // for each alternative that has parsed up to that index and expects the next item to be of that type.
        for (
            let progressCacheIndex = alternativeIndex;
            progressCacheIndex < alternatives.length;
            progressCacheIndex++
        ) {
            const parser = alternatives[progressCacheIndex];
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
                } else if (isSequence(parser) && currentParser === parser.p[currentIndex]) {
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
            debugger;
            parseAlternative(grammar, alternatives, tokens, index);
            throw debug();
        }
        return error.found;
    });
    return {
        found: unique(
            flatten(
                progressCache.map(error => {
                    if (!parseResultIsError(error)) throw debug();
                    return error.found;
                })
            )
        ),
        expected: unique(
            flatten(
                progressCache.map(error => {
                    if (!parseResultIsError(error)) throw debug();
                    return error.expected;
                })
            )
        ),
    };
};

export const parse = <NodeType, TokenType>(
    grammar: Grammar<NodeType, TokenType>,
    firstRule: string,
    tokens: Token<TokenType>[],
    index: number
): ParseResultWithIndex<NodeType, TokenType> => {
    const childrenParser = grammar[firstRule];
    if (!childrenParser) throw debug();
    if (typeof childrenParser === 'string') {
        return parse(childrenParser, firstRule, tokens, index);
    } else if (isSequence(childrenParser)) {
        return parseSequence(grammar, childrenParser, tokens, index);
    } else if (Array.isArray(childrenParser)) {
        return parseAlternative(grammar, childrenParser, tokens, index);
    } else {
        throw debug();
    }
};

const terminal = <NodeType, TokenType>(terminal: TokenType): BaseParser<NodeType, TokenType> => (
    tokens: Token<TokenType>[],
    index
): ParseResultWithIndex<NodeType, TokenType> => {
    if (index >= tokens.length) {
        const result: ParseError<TokenType> = {
            found: ['endOfFile'],
            expected: [terminal],
        };
        return result;
    }
    if (tokens[index].type == terminal) {
        return {
            success: true,
            newIndex: index + 1,
            value: tokens[index].value,
            type: tokens[index].type,
        };
    }

    return {
        expected: [terminal],
        found: [tokens[index].type],
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
        };
    } else {
        const result: ParseError<TokenType> = {
            expected: ['endOfFile'],
            found: [tokens[index].type],
        };
        return result;
    }
};

export {
    terminal,
    endOfInput,
    ParseResultWithIndex,
    ParseResult,
    ParseError,
    Ast,
    AstWithIndex,
    AstLeaf,
    AstInteriorNode,
    parseResultIsError,
    stripResultIndexes,
};
