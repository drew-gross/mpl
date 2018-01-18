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

const parseResultIsError = (r: ParseResult): r is ParseError => {
    return 'found' in r && 'expected' in r;
};
const parseResultWithIndexIsError = (r: ParseResultWithIndex): r is ParseError => {
    return 'found' in r && 'expected' in r;
};
const parseResultWithIndexIsLeaf = (r: ParseResultWithIndex): r is AstLeafWithIndex => {
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
    if (parseResultWithIndexIsError(r)) {
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
    const progressCache: ParseResultWithIndex[][] = alternatives.map(_ => []);
    for (let alternativeIndex = 0; alternativeIndex < alternatives.length; alternativeIndex++) {
        let currentParser = alternatives[alternativeIndex];
        const currentProgress = progressCache[alternativeIndex];
        let currentResult: ParseResultWithIndex;
        let currentIndex: number;

        // Check if we have cached an error for this parser. If we have, continue to the next parser.
        let currentProgressLastItem = last(currentProgress);
        if (currentProgressLastItem !== null && parseResultIsError(currentProgressLastItem)) {
            continue;
        }

        if (typeof currentParser === 'string') {
            // Reference to another rule.
            if (currentProgressLastItem !== null) {
                // We already finished this one earlier. It must be a prefix of an earlier rule.
                return currentProgressLastItem;
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
            if (currentProgressLastItem !== null) {
                // We already finished this one earlier. It must be a prefix of an earlier rule.
                return currentProgressLastItem;
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
            currentParser = currentParser.p[currentProgress.length];

            // Try the parser
            if (typeof currentParser === 'function') {
                currentResult = currentParser(tokens, index);
                currentIndex = currentProgress.length;
            } else {
                const tokenIndex = currentProgressLastItem !== null ? currentProgressLastItem.newIndex : index;
                currentResult = parse(grammar, currentParser, tokens, tokenIndex);
                currentIndex = currentProgress.length;
            }

            // Push the results into the cache for the current parser
            progressCache[alternativeIndex].push(currentResult);

            // Check if we are done
            if (!parseResultIsError(currentResult) && progressCache[alternativeIndex].length == sequence.p.length) {
                const cachedSuccess = progressCache[alternativeIndex];
                const cachedSuccessFinal = last(cachedSuccess);
                if (cachedSuccessFinal === null) throw debug();
                const result: AstNodeWithIndex = {
                    newIndex: (cachedSuccessFinal as AstNodeWithIndex).newIndex,
                    success: true,
                    children: (cachedSuccess as any),
                    type: sequence.n as AstNodeType,
                };
                return result;
            }
        }

        // Now we have a parse result and the index it was found at. Push it into the progress cache
        // for each alternative that has parsed up to that index and expects the next item to be of that type.
        for (let progressCacheIndex = alternativeIndex; progressCacheIndex < alternatives.length; progressCacheIndex++) {
            const parser = alternatives[progressCacheIndex];
            if (progressCache[progressCacheIndex].length == currentIndex) {
                if (typeof parser === 'string' && currentParser == parser) {
                    progressCache[progressCacheIndex].push(currentResult);
                } else if (typeof parser === 'function' && currentParser == parser) {
                    progressCache[progressCacheIndex].push(currentResult);
                } else if (isSequence(parser) && currentParser === parser.p[currentIndex]) {
                    progressCache[progressCacheIndex].push(currentResult);
                }
            }
        }
    }

    const errors = progressCache.map(last);

    return {
        found: unique(errors.map(error => {
            if (error == null) throw debug();
            if (!parseResultIsError(error)) throw debug();
            return error.found;
        })).join('/'),
        expected: unique(flatten(errors.map(error => {
            if (error == null) throw debug();
            if (!parseResultIsError(error)) throw debug();
            return error.expected;
        }))),
    };
};

export const parse = (grammar: Grammar, firstRule: string, tokens: Token[], index: number): ParseResultWithIndex => {
    const childrenParser = grammar[firstRule];
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
