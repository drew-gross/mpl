const parseProgram = require('./parser.js')
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
    if (!input) debugger;
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

const statementTreeToStatementList = functionAst => {
    const result = {
        name: functionAst.name,
        argument: functionAst.argument,
        statements: [],
    };
    let currentStatement = functionAst.body;
    while (currentStatement.type === 'statement') {
        result.statements.push(currentStatement.children[0]);
        currentStatement = currentStatement.children[2];
    }
    // Final statement of function. If it is a bare expression and is the only statement,
    // allow it instead of a return statement.
    if (result.statements.length === 0) {
        result.statements.push({
            type: 'returnStatement',
            children: [{ type: 'return', value: null }, currentStatement],
        });
    } else {
        result.statements.push(currentStatement);
    }
    return result;
}

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
        const otherFunctions = ast.children.map(extractFunctions);
        newAst.type = ast.type;
        newAst.children = [];
        otherFunctions.forEach(({ functions, program }) => {
            newFunctions.push(...functions);
            newAst.children.push(program);
        });
    } else {
        newAst.type = ast.type;
        newAst.value = ast.value;
    }
    return { functions: newFunctions, program: newAst };
};

const extractVariables = ast => {
    if (ast.type === 'assignment') {
        return [ast.children[0].value];
    } else if ('children' in ast) {
        return flatten(ast.children.map(extractVariables));
    } else {
        return [];
    }
};

const parse = tokens => {
    let ast = parseProgram(tokens, 0)

    if (ast.success === false) {
        return { error: 'Unable to parse' };
    }
    ast = flattenAst(ast);

    // repair associativity of product
    ast = repairAssociativity(ast);

    // Lower product 3 -> product 1
    ast = transformAst('product3', node => ({ type: 'product1', children: node.children }), ast);

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

const countTemporariesInExpression = ast => {
    if ('value' in ast) {
        return 0;
    }
    switch (ast.type) {
        case 'returnStatement': return countTemporariesInExpression(ast.children[1]);
        case 'product': return 1 + Math.max(...ast.children.map(countTemporariesInExpression));
        case 'assignment': return 0;
        case 'callExpression': return 0;
        default: debugger;
    }
}

const countTemporariesInFunction = ({ statements }) => {
    return Math.max(...statements.map(countTemporariesInExpression));
}

const compile = ({ source, target }) => {
    const tokens = lex(source);
    const ast = parse(tokens);
    const { functions, program } = extractFunctions(ast);

    const functionsWithStatementList = functions.map(statementTreeToStatementList);
    const programWithStatementList = statementTreeToStatementList({ body: program });

    const functionTemporaryCounts = functionsWithStatementList.map(countTemporariesInFunction);
    const programTemporaryCount = countTemporariesInFunction(programWithStatementList);

    const variables = flatten(programWithStatementList.statements.map(extractVariables));

    // Modifications here :(
    functionsWithStatementList.forEach((item, index) => {
        item.temporaryCount = functionTemporaryCounts[index];
    });
    programWithStatementList.temporaryCount = programTemporaryCount

    if (target == 'js') {
        return toJS(functionsWithStatementList, variables, programWithStatementList);
    } else if (target == 'c') {
        return toC(functionsWithStatementList, variables, programWithStatementList);
    } else if (target == 'mips') {
        return toMips(functionsWithStatementList, variables, programWithStatementList);
    }
};

module.exports = { parse, lex, compile, lowerBracketedExpressions };
