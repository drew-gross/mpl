const { alternative, sequence, terminal } = require('./parser-combinator.js');
const { toJS, toC, toMips } = require('./codegen.js');

let tokensToString = tokens => tokens.map(token => token.string).join('');

const lex = input => {

    const tokenSpecs = [{
        token: 'return',
        type: 'return',
        toString: () => 'return',
    }, {
        token: '[a-zA-Z]\\w*',
        type: 'identifier',
        action: x => x,
        toString: x => x,
    }, {
        token: '=',
        type: 'assignment',
        toString: () => '=',
    }, {
        token: '\\d+',
        type: 'number',
        action: parseInt,
        toString: x => x.toString(),
    }, {
        token: '\\+',
        type: 'sum',
        toString: () => '+',
    }, {
        token: '\\*',
        type: 'product',
        toString: () => '*',
    }, {
        token: '\\(',
        type: 'leftBracket',
        toString: () => '(',
    }, {
        token: '\\)',
        type: 'rightBracket',
        toString: () => ')',
    }, {
        token: '.*',
        type: 'invalid',
        action: x => x,
        toString: x => x,
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
            const value = action(match[1]);
            tokens.push({
                type: tokenSpec.type,
                value,
                string: tokenSpec.toString(value),
            });
            break;
        }
    }
    return tokens;
};

let parseProgram = (t, i) => parseProgramI(t, i);
let parseStatement = (t, i) => parseStatementI(t, i);
let parseExpression = (t, i) => parseExpressionI(t, i);
let parseProduct = (t, i) => parseProductI(t, i);

// Grammar:
// PROGRAM -> STATEMENT PROGRAM | return EXPRESSION
// STATEMENT -> identifier = EXPRESSION
// EXPRESSION -> PRODUCT | ( EXPRESSION ) | int
// PRODUCT -> int * EXPRESSION | ( EXPRESSION ) * EXPRESSION

const parseProgramI = alternative([
    sequence('statement', [parseStatement, parseProgram]),
    sequence('returnStatement', [terminal('return'), parseExpression]),
]);

const parseStatementI = sequence('assignment', [
    terminal('identifier'),
    terminal('assignment'),
    parseExpression,
]);

const parseExpression2 = sequence('bracketedExpression', [
    terminal('leftBracket'),
    parseExpression,
    terminal('rightBracket'),
]);
const parseExpressionI = alternative([parseProduct, parseExpression2, terminal('number')]);

const parseProduct1 = sequence('product1', [
    terminal('number'),
    terminal('product'),
    parseExpression,
]);
const parseProduct2 = sequence('product2', [
    terminal('leftBracket'),
    parseExpression,
    terminal('rightBracket'),
    terminal('product'),
    parseExpression,
]);
const parseProductI = alternative([parseProduct1, parseProduct2]);

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
const lowerBracketedExpressions = ast => transformAst('bracketedExpression', node => node.children[1], ast);

const transformAst = (nodeType, f, ast) => {
    if (ast.type === nodeType) {
        return transformAst(nodeType, f, f(ast));
    } else if ('children' in ast) {
        return {
            type: ast.type,
            children: ast.children.map(child => transformAst(nodeType, f, child)),
        };
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

    // repair associativity of product
    ast = repairAssociativity(ast);

    // Lower product 2 -> product 1
    ast = transformAst('product2', node => ({
        type: 'product1',
        children: [node.children[1], { type: 'product', value: null }, node.children[4]],
    }), ast);

    // Lower bracketed expressions to nothing
    ast = lowerBracketedExpressions(ast);

    // Lower product1 to product
    ast = transformAst('product1', node => ({ type: 'product', children: [node.children[0], node.children[2]] }), ast);
    return ast;
};


const compile = ({ source, target }) => {
    let tokens = lex(source);
    ast = parse(tokens);
    if (target == 'js') {
        return toJS(ast);
    } else if (target == 'c') {
        return toC(ast);
    } else if (target == 'mips') {
        return toMips(ast);
    }
};

module.exports = { parse, lex, compile, lowerBracketedExpressions };
