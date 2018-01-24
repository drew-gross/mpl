import { Token, TokenType } from './lex.js';
import unique from './util/list/unique.js';
import flatten from './util/list/flatten.js';
import last from './util/list/last.js';
import assertNever from './util/assertNever.js';
import debug from './util/debug.js';

export type AstNodeType =
    'return' |
    'booleanLiteral' |
    'number' |
    'product' |
    'assignment' |
    'typedAssignment' |
    'subtraction' |
    'identifier' |
    'equality' |
    'stringLiteral' |
    'fatArrow' |
    'type' |
    'sum' |
    'ternaryOperator' |
    'statementSeparator' |
    'leftBracket' |
    'rightBracket' |
    'leftCurlyBrace' |
    'rightCurlyBrace' |
    'endOfFile' |
    'colon' |
    'concatenation' |
    'comma';

interface AstInteriorNode {
    type: AstNodeType;
    children: AstNode[];
};

type AstLeaf = {
    type: AstNodeType;
    value: string | number | null | undefined;
};

type AstNode = AstInteriorNode | AstLeaf;

interface AstLeafWithIndex {
    success: true,
    newIndex: number,
    type: AstNodeType,
    value: string | number | null | undefined,
};

interface AstInteriorNodeWithIndex {
    success: true,
    newIndex: number,
    type: AstNodeType,
    children: AstNodeWithIndex[],
};

type AstNodeWithIndex = AstInteriorNodeWithIndex | AstLeafWithIndex;

interface ParseError {
    found: string,
    expected: TokenType[],
};

type ParseResultWithIndex = ParseError | AstNodeWithIndex;
type ParseResult = ParseError | AstNode;

const parseResultIsError = (r: ParseResult | ParseResultWithIndex | AstNodeWithIndex[]): r is ParseError => {
    if (!r) throw debug();
    return 'found' in r && 'expected' in r;
};
const parseResultWithIndexIsLeaf = (r: ParseResultWithIndex): r is AstLeafWithIndex => {
    if (!r) throw debug();
    return 'value' in r;
};

const stripNodeIndexes = (r: AstNodeWithIndex): AstNode => {
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

const stripResultIndexes = (r: ParseResultWithIndex): ParseResult => {
    if (parseResultIsError(r)) {
        return r;
    }
    return stripNodeIndexes(r);
};

const tokenTypeToAstNodeType = (token: TokenType): AstNodeType | undefined => {
    switch (token) {
        case 'return': return 'return';
        case 'number': return 'number';
        case 'booleanLiteral': return 'booleanLiteral';
        case 'product': return 'product';
        case 'assignment': return 'assignment';
        case 'subtraction': return 'subtraction';
        case 'identifier': return 'identifier';
        case 'equality': return 'equality';
        case 'stringLiteral': return 'stringLiteral';
        case 'type': return 'type';
        case 'fatArrow': return 'fatArrow';
        case 'sum': return 'sum';
        case 'ternaryOperator': return 'ternaryOperator';
        case 'statementSeparator': return 'statementSeparator';
        case 'leftBracket': return 'leftBracket';
        case 'rightBracket': return 'rightBracket';
        case 'leftCurlyBrace': return 'leftCurlyBrace';
        case 'rightCurlyBrace': return 'rightCurlyBrace';
        case 'endOfFile': return 'endOfFile';
        case 'colon': return 'colon';
        case 'comma': return 'comma';
        case 'invalid': return undefined;
        case 'concatenation': return 'concatenation';
        default: return assertNever(token);
    }
};


type BaseParser = (tokens: Token[], index: number) => ParseResultWithIndex;
type SequenceParser = { n: string, p: (string | BaseParser)[] };
type AlternativeParser = (SequenceParser | string | BaseParser)[];

interface Grammar {
    [index: string]: SequenceParser | AlternativeParser,
}

const isSequence = (val: SequenceParser | AlternativeParser | BaseParser | string): val is SequenceParser =>  {
    if (typeof val === 'string') return false;
    if (!val) throw debug();
    return 'n' in val;
}

const parseSequence = (
    grammar: Grammar,
    parser: SequenceParser,
    tokens: Token[],
    index: number
): ParseResultWithIndex => {
    const results: AstNodeWithIndex[] = [];
    for (const p of parser.p) {
        let result: ParseResultWithIndex;
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

    return {
        success: true,
        newIndex: index,
        type: parser.n as AstNodeType,
        children: results,
    };
};

const parseAlternative = (
    grammar: Grammar,
    alternatives: AlternativeParser,
    tokens: Token[],
    index: number
): ParseResultWithIndex => {
    const alternativeIndex: number = 0;
    const progressCache: (ParseError | AstNodeWithIndex[])[] = alternatives.map(_ => []);
    for (let alternativeIndex = 0; alternativeIndex < alternatives.length; alternativeIndex++) {
        let alternativeNeedsSubtracting = false;
        let currentParser = alternatives[alternativeIndex];
        const currentProgressRef = progressCache[alternativeIndex];
        let currentResult: ParseResultWithIndex;
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
            if (currentProgressLastItem !== null && !parseResultIsError(currentProgressLastItem) && currentProgressRef.length === sequence.p.length) {
                const result: AstNodeWithIndex = {
                    newIndex: currentProgressLastItem.newIndex,
                    success: true,
                    children: currentProgressRef,
                    type: sequence.n as AstNodeType,
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
                const result: AstNodeWithIndex = {
                    newIndex: cachedSuccess.newIndex,
                    success: true,
                    children: currentProgressRef,
                    type: sequence.n as AstNodeType,
                };
                return result;
            }
        }

        // Now we have a parse result and the index it was found at. Push it into the progress cache
        // for each alternative that has parsed up to that index and expects the next item to be of that type.
        for (let progressCacheIndex = alternativeIndex; progressCacheIndex < alternatives.length; progressCacheIndex++) {
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

    progressCache.map((error: (ParseError | AstNodeWithIndex[])) => {
        if (!parseResultIsError(error)) {
            debugger
            parseAlternative(
                grammar,
                alternatives,
                tokens,
                index
            )
            throw debug();
        }
        return error.found;
    })
    return {
        found: unique(progressCache.map(error => {
            if (!parseResultIsError(error)) throw debug();
            return error.found;
        })).join('/'),
        expected: unique(flatten(progressCache.map(error => {
            if (!parseResultIsError(error)) throw debug();
            return error.expected;
        }))),
    };
};

export const parse = (grammar: Grammar, firstRule: string, tokens: Token[], index: number): ParseResultWithIndex => {
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

const terminal = (terminal: TokenType) => (tokens: Token[], index): ParseResultWithIndex => {
    if (index >= tokens.length) {
        return {
            found: 'endOfFile',
            expected: [terminal],
        };
    }
    if (tokens[index].type == terminal) {
        const astNodeType = tokenTypeToAstNodeType(terminal);
        if (astNodeType !== undefined) {
            return {
                success: true,
                newIndex: index + 1,
                value: tokens[index].value,
                type: astNodeType,
            }
        } else {
            return {
                expected: [terminal],
                found: tokens[index].type,
            }
        }
    }

    return {
        expected: [terminal],
        found: tokens[index].type,
    };
}

const endOfInput = (tokens: Token[], index: number): ParseResultWithIndex => {
    if (index == tokens.length) {
        return {
            success: true,
            newIndex: index + 1,
            value: 'endOfFile',
            type: 'endOfFile',
        }
    } else {
        return {
            expected: ['endOfFile'],
            found: tokens[index].type,
        }
    }
}

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
