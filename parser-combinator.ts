import { Token, TokenType } from './lex.js';
import unique from './util/list/unique.js';
import flatten from './util/list/flatten.js';
import assertNever from './util/assertNever.js';

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

const alternative = parsers => (tokens: Token[], index): ParseResultWithIndex => {
    const errors: ParseError[] = [];
    for (const parser of parsers) {
        const result = parser(tokens, index);
        if (parseResultWithIndexIsError(result)) {
            errors.push(result);
        } else {
            return result;
        }
    }

    return {
        found: unique(errors.map(e => e.found)).join('/'),
        expected: unique(flatten(errors.map(e => e.expected))),
    };
}

const sequence = (type, parsers) => (tokens: Token[], index): ParseResultWithIndex => {
    const results: AstNodeWithIndex[] = []
    for (const parser of parsers) {
        const result = parser(tokens, index);
        if (!result.success) {
            return result;
        }
        results.push(result);
        index = result.newIndex;
    }
    return {
        success: true,
        newIndex: index,
        type: type,
        children: results,
    };
}

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
    alternative,
    sequence,
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
