const { alternative, sequence, terminal } = require('./parser-combinator.js');
const { toJS, toC, toMips } = require('./codegen.js');

const flatten = array => array.reduce((a, b) => a.concat(b), []);

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
        token: ';|\\n',
        type: 'statementSeparator',
        toString: () => '\n',
    }, {
        token: '=>',
        type: 'fatArrow',
        toString: () => '=>',
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
            const match = input.match(RegExp(`^(${tokenSpec.token})[ \\t]*`));
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

const parseProgram = (t, i) => parseProgramI(t, i);
const parseStatement = (t, i) => parseStatementI(t, i);
const parseFunction = (t, i) => parseFunctionI(t, i);
const parseArgList = (t, i) => parseArgListI(t, i);
const parseExpression = (t, i) => parseExpressionI(t, i);
const parseProduct = (t, i) => parseProductI(t, i);

// Grammar:
// PROGRAM -> STATEMENT STATEMENT_SEPARATOR PROGRAM | return EXPRESSION
// STATEMENT -> identifier = FUNCTION
// FUNCTION -> ARG_LIST => EXPRESSION
// ARG_LIST -> identifier, ARG_LIST | identifier
// EXPRESSION -> PRODUCT | ( EXPRESSION ) | int
// PRODUCT -> int * EXPRESSION | ( EXPRESSION ) * EXPRESSION

const parseProgramI = alternative([
    sequence('statement', [parseStatement, terminal('statementSeparator'), parseProgram]),
    sequence('returnStatement', [terminal('return'), parseExpression]),
]);

const parseStatementI = sequence('assignment', [
    terminal('identifier'),
    terminal('assignment'),
    parseFunction,
]);

const parseFunctionI = sequence('function', [parseArgList, terminal('fatArrow'), parseExpression]);

const parseArgListI = alternative([
    sequence('argList', [terminal('identifier'), terminal('comma'), parseArgList]),
    terminal('identifier'),
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

let functionId = 0;

const extractFunctions = ast => {
    const newFunctions = [];
    const newAst = {};
    if (ast.type === 'function') {
        const functionName = `anonymous_${functionId}`;
        functionId++;
        newFunctions.push({
            name: functionName,
            argument: ast.children[0],
            body: ast.children[2]
        });
        newAst.type = 'functionLiteral';
        newAst.value = functionName;
    } else if ('children' in ast) {
        const otherFuntions = ast.children.map(extractFunctions);
        newAst.type = ast.type;
        newAst.children = [];
        otherFuntions.forEach(({ functions, program }) => {
            newFunctions.push(...functions);
            newAst.children.push(program);
        });
    } else {
        newAst.type = ast.type;
        newAst.value = ast.value;
    }
    return { functions: newFunctions, program: newAst };
};

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
    const tokens = lex(source);
    const ast = parse(tokens);
    const { functions, program } = extractFunctions(ast);
    if (target == 'js') {
        return toJS(functions, program);
    } else if (target == 'c') {
        return toC(functions, program);
    } else if (target == 'mips') {
        return toMips(functions, program);
    }
};

module.exports = { parse, lex, compile, lowerBracketedExpressions };
