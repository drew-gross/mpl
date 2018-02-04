import { Token } from './lex.js';
import unique from './util/list/unique.js';
import flatten from './util/list/flatten.js';
import last from './util/list/last.js';
import assertNever from './util/assertNever.js';
import debug from './util/debug.js';

type AstNodeType<AstInteriorNodeType, AstLeafNodeType> = AstInteriorNodeType | AstLeafNodeType;

interface AstInteriorNode<AstInteriorNodeType, AstLeafNodeType> {
    type: AstInteriorNodeType;
    children: AstNode<AstInteriorNodeType, AstLeafNodeType>[];
}

type AstLeaf<AstLeafNodeType> = {
    type: AstLeafNodeType | 'endOfFile';
    value: string | number | null | undefined;
};

type AstNode<AstInteriorNodeType, AstLeafNodeType> =
    | AstInteriorNode<AstInteriorNodeType, AstLeafNodeType>
    | AstLeaf<AstLeafNodeType>;

interface AstLeafWithIndex<AstLeafNodeType> {
    success: true;
    newIndex: number;
    type: AstLeafNodeType | 'endOfFile';
    value: string | number | null | undefined;
}

interface AstInteriorNodeWithIndex<AstInteriorNodeType, AstLeafNodeType> {
    success: true;
    newIndex: number;
    type: AstInteriorNodeType;
    children: AstNodeWithIndex<AstInteriorNodeType, AstLeafNodeType>[];
}

type AstNodeWithIndex<AstInteriorNodeType, AstLeafNodeType> =
    | AstInteriorNodeWithIndex<AstInteriorNodeType, AstLeafNodeType>
    | AstLeafWithIndex<AstLeafNodeType>;

interface ParseError<TokenType> {
    found: (TokenType | 'endOfFile')[];
    expected: (TokenType | 'endOfFile')[];
}

type ParseResultWithIndex<AstInteriorNodeType, AstLeafNodeType, TokenType> =
    | ParseError<TokenType>
    | AstNodeWithIndex<AstInteriorNodeType, AstLeafNodeType>;
type ParseResult<AstInteriorNodeType, AstLeafNodeType, TokenType> =
    | ParseError<TokenType>
    | AstNode<AstInteriorNodeType, AstLeafNodeType>;

const parseResultIsError = <AstInteriorNodeType, AstLeafNodeType, TokenType>(
    result:
        | ParseResult<AstInteriorNodeType, AstLeafNodeType, TokenType>
        | ParseResultWithIndex<AstInteriorNodeType, AstLeafNodeType, TokenType>
        | AstNodeWithIndex<AstInteriorNodeType, AstLeafNodeType>[]
): result is ParseError<TokenType> => {
    if (!result) throw debug();
    return 'found' in result && 'expected' in result;
};
const parseResultWithIndexIsLeaf = <AstInteriorNodeType, AstLeafNodeType, TokenType>(
    r: ParseResultWithIndex<AstInteriorNodeType, AstLeafNodeType, TokenType>
): r is AstLeafWithIndex<AstLeafNodeType> => {
    if (!r) throw debug();
    return 'value' in r;
};

const stripNodeIndexes = <AstInteriorNodeType, AstLeafNodeType>(
    r: AstNodeWithIndex<AstInteriorNodeType, AstLeafNodeType>
): AstNode<AstInteriorNodeType, AstLeafNodeType> => {
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

const stripResultIndexes = <InteriorNodeType, LeafNodeType, TokenType>(
    r: ParseResultWithIndex<InteriorNodeType, LeafNodeType, TokenType>
): ParseResult<InteriorNodeType, LeafNodeType, TokenType> => {
    if (parseResultIsError(r)) {
        return r;
    }
    return stripNodeIndexes(r);
};

export type BaseParser<InteriorNodeType, LeafNodeType, TokenType> = (
    tokens: Token<TokenType>[],
    index: number
) => ParseResultWithIndex<InteriorNodeType, LeafNodeType, TokenType>;
export type SequenceParser<InteriorNodeType, LeafNodeType, TokenType> = {
    n: InteriorNodeType;
    p: (string | BaseParser<InteriorNodeType, LeafNodeType, TokenType>)[];
};
type AlternativeParser<InteriorNodeType, LeafNodeType, TokenType> = (
    | SequenceParser<InteriorNodeType, LeafNodeType, TokenType>
    | string
    | BaseParser<InteriorNodeType, LeafNodeType, TokenType>)[];

export interface Grammar<InteriorNodeType, LeafNodeType, TokenType> {
    // Ideally would have InteriorNodeType instead of string here but typescript doesn't allow that.
    [index: string]:
        | SequenceParser<InteriorNodeType, LeafNodeType, TokenType>
        | SequenceParser<InteriorNodeType, LeafNodeType, TokenType>[]
        | AlternativeParser<InteriorNodeType, LeafNodeType, TokenType>;
}

const isSequence = <InteriorNodeType, LeafNodeType, TokenType>(
    val:
        | SequenceParser<InteriorNodeType, LeafNodeType, TokenType>
        | AlternativeParser<InteriorNodeType, LeafNodeType, TokenType>
        | BaseParser<InteriorNodeType, LeafNodeType, TokenType>
        | string
): val is SequenceParser<InteriorNodeType, LeafNodeType, TokenType> => {
    if (typeof val === 'string') return false;
    if (!val) throw debug();
    return 'n' in val;
};

const parseSequence = <InteriorNodeType, LeafNodeType, TokenType>(
    grammar: Grammar<InteriorNodeType, LeafNodeType, TokenType>,
    parser: SequenceParser<InteriorNodeType, LeafNodeType, TokenType>,
    tokens: Token<TokenType>[],
    index: number
): ParseResultWithIndex<InteriorNodeType, LeafNodeType, TokenType> => {
    const results: AstNodeWithIndex<InteriorNodeType, LeafNodeType>[] = [];
    for (const p of parser.p) {
        let result: ParseResultWithIndex<InteriorNodeType, LeafNodeType, TokenType>;
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
    const result: AstNodeWithIndex<InteriorNodeType, LeafNodeType> = {
        success: true,
        newIndex: index,
        type: parser.n,
        children: results,
    };
    return result;
};

const parseAlternative = <InteriorNodeType, LeafNodeType, TokenType>(
    grammar: Grammar<InteriorNodeType, LeafNodeType, TokenType>,
    alternatives: AlternativeParser<InteriorNodeType, LeafNodeType, TokenType>,
    tokens: Token<TokenType>[],
    index: number
): ParseResultWithIndex<InteriorNodeType, LeafNodeType, TokenType> => {
    const alternativeIndex: number = 0;
    const progressCache: (
        | ParseError<TokenType>
        | AstNodeWithIndex<InteriorNodeType, LeafNodeType>[])[] = alternatives.map(_ => []);
    for (let alternativeIndex = 0; alternativeIndex < alternatives.length; alternativeIndex++) {
        let alternativeNeedsSubtracting = false;
        let currentParser = alternatives[alternativeIndex];
        const currentProgressRef: ParseError<TokenType> | AstNodeWithIndex<InteriorNodeType, LeafNodeType>[] =
            progressCache[alternativeIndex];
        let currentResult: ParseResultWithIndex<InteriorNodeType, LeafNodeType, TokenType>;
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
                const result: AstNodeWithIndex<InteriorNodeType, LeafNodeType> = {
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
                const result: AstNodeWithIndex<InteriorNodeType, LeafNodeType> = {
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

    progressCache.map((error: ParseError<TokenType> | AstNodeWithIndex<InteriorNodeType, LeafNodeType>[]) => {
        if (!parseResultIsError(error)) {
            debugger;
            parseAlternative(grammar, alternatives, tokens, index);
            throw debug();
        }
        return error.found;
    });
    return {
        found: flatten(
            unique(
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

export const parse = <InteriorNodeType, LeafNodeType, TokenType>(
    grammar: Grammar<InteriorNodeType, LeafNodeType, TokenType>,
    firstRule: string,
    tokens: Token<TokenType>[],
    index: number
): ParseResultWithIndex<InteriorNodeType, LeafNodeType, TokenType> => {
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

const terminal = <InteriorNodeType, LeafNodeType, TokenType>(
    tokenToLeafNode: (t: TokenType) => LeafNodeType,
    terminal: TokenType
): BaseParser<InteriorNodeType, LeafNodeType, TokenType> => (
    tokens: Token<TokenType>[],
    index
): ParseResultWithIndex<InteriorNodeType, LeafNodeType, TokenType> => {
    if (index >= tokens.length) {
        const result: ParseError<TokenType> = {
            found: ['endOfFile'],
            expected: [terminal],
        };
        return result;
    }
    if (tokens[index].type == terminal) {
        const astNodeType: LeafNodeType = tokenToLeafNode(terminal);
        if (astNodeType !== undefined) {
            return {
                success: true,
                newIndex: index + 1,
                value: tokens[index].value,
                type: astNodeType,
            };
        } else {
            const result: ParseError<TokenType> = {
                expected: [terminal],
                found: [tokens[index].type],
            };
            return result;
        }
    }

    return {
        expected: [terminal],
        found: [tokens[index].type],
    };
};

const endOfInput = <InteriorNodeType, LeafNodeType, TokenType>(
    tokens: Token<TokenType>[],
    index: number
): ParseResultWithIndex<InteriorNodeType, LeafNodeType, TokenType> => {
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
    AstNode,
    AstNodeWithIndex,
    AstLeaf,
    AstInteriorNode,
    parseResultIsError,
    stripResultIndexes,
};
