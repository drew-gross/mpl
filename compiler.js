const { alternative, sequence, terminal } = require('./parser-combinator.js');
const { toJS, toC, toMips } = require('./codegen.js');

const lex = input => {

    const tokenSpecs = [{
        token: 'return',
        type: 'return',
    }, {
        token: '[a-zA-Z]\\w*',
        type: 'identifier',
        action: x => x,
    }, {
        token: '=',
        type: 'assignment',
    }, {
        token: '\\d+',
        type: 'number',
        action: parseInt,
    }, {
        token: '\\+',
        type: 'sum',
    }, {
        token: '\\*',
        type: 'product',
    }, {
        token: '\\(',
        type: 'leftBracket',
    }, {
        token: '\\)',
        type: 'rightBracket',
    }, {
        token: '.*',
        type: 'invalid',
        action: x => x,
    }];

    // slurp initial whitespace
    input = input.trim();

    // consume input reading tokens
    let tokens = [];
    while (input.length > 0) {
        for (const tokenSpec of tokenSpecs) {
            const match = input.match(RegExp(`^(${tokenSpec.token})\\s*`));
            if (!match) continue;
            input = input.slice(match[0].length);
            const action = tokenSpec.action || (() => null);
            tokens.push({ type: tokenSpec.type, value: action(match[1])});
            break;
        }
    }
    return tokens;
};

// Grammar:
// PROGRAM -> STATEMENT PROGRAM | return EXPRESSION
// STATEMENT -> identifier = EXPRESSION
// EXPRESSION -> PRODUCT | ( EXPRESSION ) | int
// PRODUCT -> int * EXPRESSION | ( EXPRESSION * EXPRESSION )

const parseProduct1 = sequence('product1', [
    terminal('number'),
    terminal('product'),
    (t, i) => parseExpression(t, i),
]);
const parseProduct2 = sequence('product2', [
    terminal('leftBracket'),
    (t, i) => parseExpression(t, i),
    terminal('product'),
    (t, i) => parseExpression(t, i),
    terminal('rightBracket'),
]);
const parseProduct = alternative([parseProduct1, parseProduct2]);

const parseExpression1 = parseProduct;
const parseExpression2 = sequence('bracketedExpression', [
    terminal('leftBracket'),
    (t, i) => parseExpression(t, i),
    terminal('rightBracket'),
]);
const parseExpression3 = terminal('number');

const parseExpression = alternative([parseExpression1, parseExpression2, parseExpression3]);

const parseStatement = sequence('assignment', [
    terminal('identifier'),
    terminal('assignment'),
    parseExpression,
]);

const parseProgram = alternative([
    sequence('statement', [parseStatement, (t, i) => parseProgram(t, i)]),
    sequence('returnStatement', [terminal('return'), parseExpression]),
]);

const flattenAst = ast => {
    if (ast.children) {
        return {
            type: ast.type,
            children: ast.children.map(flattenAst),
        };
    } else {
        return {
            type: ast.type,
            value: ast.value,
        };
    }
}

const repairAssociativity = ast => {
    if (ast.type === 'product1' && ast.children[2].type === 'product1') {
        return {
            type: 'product1',
            children: [{
                type: 'product1',
                children: [
                    repairAssociativity(ast.children[0]),
                    { type: 'product', value: null },
                    repairAssociativity(ast.children[2].children[0]),
                ],
            }, {
                type: 'product',
                value: null,
            },
                repairAssociativity(ast.children[2].children[2]),
            ],
        };
    } else if ('children' in ast) {
        return {
            type: ast.type,
            children: ast.children.map(repairAssociativity),
        }
    } else {
        return ast;
    }
}

const parse = tokens => {
    let ast = parseProgram(tokens, 0)
    if (ast.success === false) {
        return { error: 'Unable to parse' };
    }
    ast = flattenAst(ast);
    ast = repairAssociativity(ast);
    return ast;
};

const lowerBracketedExpressions = ast => {
    if (ast.type === 'bracketedExpression') {
        return lowerBracketedExpressions(ast.children[1]);
    } else if ('children' in ast) {
        return {
            type: ast.type,
            children: ast.children.map(lowerBracketedExpressions),
        };
    } else {
        return ast;
    }
};

const compile = ({ source, target }) => {
    let tokens = lex(source);
    ast = parse(tokens);
    ast = repairAssociativity(ast);
    ast = lowerBracketedExpressions(ast);
    if (target == 'js') {
        return toJS(ast);
    } else if (target == 'c') {
        return toC(ast);
    } else if (target == 'mips') {
        return toMips(ast);
    }
};

module.exports = { parse, lex, compile, lowerBracketedExpressions };
