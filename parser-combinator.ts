import { Token } from './lex.js';
import unique from './util/list/unique.js';
import flatten from './util/list/flatten.js';


type AstLeaf = {
    success?: true,
    newIndex?: number,
    type: string,
    value: any,
};

type AstInteriorNode = {
    success?: true,
    newIndex?: number,
    type: string,
    children: any[],
};

type AstNode = AstInteriorNode | AstLeaf;

type ParseError = {
    found: string,
    expected: string[],
};

type ParseResult = {
    success: false,
    error: ParseError,
} | AstNode;

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
    const results = []
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

const terminal = (terminal: string) => (tokens: Token[], index): ParseResult => {
    if (index >= tokens.length) {
        return {
            success: false,
            error: {
                found: 'end of file',
                expected: [terminal],
            },
        };
    }
    if (tokens[index].type == terminal) {
        return {
            success: true,
            newIndex: index + 1,
            value: tokens[index].value,
            type: terminal,
        };
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
