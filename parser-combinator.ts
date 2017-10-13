import { Token, TokenType } from './lex.js';
import unique from './util/list/unique.js';
import flatten from './util/list/flatten.js';

type AstNodeType =
    'return' |
    'booleanLiteral' |
    'number' |
    'product' |
    'assignment' |
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
    'comma';

type AstLeaf = {
    success?: true,
    newIndex?: number,
    type: AstNodeType,
    value: any,
};

type AstInteriorNode = {
    success?: true,
    newIndex?: number,
    type: AstNodeType,
    children: any[],
};

type AstNode = AstInteriorNode | AstLeaf;

type ParseError = {
    found: string,
    expected: TokenType[],
};

type ParseResult = {
    success: false,
    error: ParseError,
} | AstNode;

function assertNever(x: never): never {
    throw new Error(`Unexpected object: ${x}`);
}

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
        default: return assertNever(token);
    }
};

const alternative = parsers => (tokens: Token[], index): ParseResult => {
    const errors: ParseError[] = [];
    for (const parser of parsers) {
        const result = parser(tokens, index);
        if (result.success) {
            return result;
        } else {
            errors.push(result.error);
        }
    }

    return {
        success: false,
        error: {
            found: unique(errors.map(e => e.found)).join('/'),
            expected: unique(flatten(errors.map(e => e.expected))),
        },
    };
}

const sequence = (type, parsers) => (tokens: Token[], index): ParseResult => {
    const results: any = []
    for (const parser of parsers) {
        const result = parser(tokens, index);
        if (!result.success) {
            return {
                success: false,
                error: result.error,
            };
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

const terminal = (terminal: TokenType) => (tokens: Token[], index): ParseResult => {
    if (index >= tokens.length) {
        return {
            success: false,
            error: {
                found: 'endOfFile',
                expected: [terminal],
            },
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
                success: false,
                error: {
                    expected: [terminal],
                    found: tokens[index].type,
                }
            }
        }
    }

    return {
        success: false,
        error: {
            expected: [terminal],
            found: tokens[index].type,
        },
    };
}

export {
    alternative,
    sequence,
    terminal,
    ParseResult,
    AstNode,
    AstLeaf,
    AstInteriorNode,
};
