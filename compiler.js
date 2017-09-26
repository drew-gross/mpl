const lex = require('./lex.js');
const parseProgram = require('./parser.js')
const { toJS, toC, toMips } = require('./codegen.js');

const flatten = array => array.reduce((a, b) => a.concat(b), []);

let tokensToString = tokens => tokens.map(token => token.string).join('');

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

const repairAssociativity = (nodeTypeToRepair, ast) => {
    if (ast.type === nodeTypeToRepair && ast.children[1].type === nodeTypeToRepair) {
        return {
            type: nodeTypeToRepair,
            children: [
                {
                    type: nodeTypeToRepair,
                    children: [
                        repairAssociativity(nodeTypeToRepair, ast.children[0]),
                        repairAssociativity(nodeTypeToRepair, ast.children[1].children[0]),
                    ],
                },
                repairAssociativity(nodeTypeToRepair, ast.children[1].children[1]),
            ],
        };
    } else if ('children' in ast) {
        return {
            type: ast.type,
            children: ast.children.map(child => repairAssociativity(nodeTypeToRepair, child)),
        }
    } else {
        return ast;
    }
}

const transformAst = (nodeType, f, ast) => {
    if (!ast) debugger;
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
    // and is not a returns statement, turn it into a return statement.
    if (result.statements.length === 0 && currentStatement.type !== 'returnStatement') {
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
    } else if (ast.type === 'functionWithBlock') {
        const functionName = `anonymous_${functionId}`;
        functionId++;
        newFunctions.push({
            name: functionName,
            argument: ast.children[0],
            body: ast.children[3],
        });
        newAst.type = 'functionLiteral',
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
    if (ast.type === 'assignment' || ast.type === 'typedAssignment') {
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
        return {
            ast: {},
            parseErrors: ['Unable to parse'],
        };
    }
    ast = flattenAst(ast);

    // repair associativity of subtraction1
    ast = repairAssociativity('subtraction1', ast);

    // Product 3 -> product 1
    ast = transformAst('product3', node => ({ type: 'product1', children: node.children }), ast);

    // Product 2 -> product 1
    ast = transformAst('product2', node => {
        return {
            type: 'product1',
            children: [node.children[1], { type: 'product', value: null }, node.children[4]],
        };
    }, ast);


    // Product 1 -> product
    ast = transformAst('product1', node => ({ type: 'product', children: [node.children[0], node.children[2]] }), ast);

    // repair associativity of product
    ast = repairAssociativity('product', ast);

    // Subtraction 1 -> subtraction
    ast = transformAst('subtraction1', node => ({ type: 'subtraction', children: [node.children[0], node.children[2]] }), ast);

    // repair associativity of subtraction
    ast = repairAssociativity('subtraction', ast);

    // Bracketed expressions -> nothing. Must happen after associativity repair or we will break
    // associativity of brackets.
    ast = transformAst('bracketedExpression', node => node.children[1], ast);

    return {
        ast,
        parseErrors: [],
    };
};

const countTemporariesInExpression = ast => {
    if ('value' in ast) {
        return 0;
    }
    switch (ast.type) {
        case 'returnStatement': return countTemporariesInExpression(ast.children[1]);
        case 'product': return 1 + Math.max(...ast.children.map(countTemporariesInExpression));
        case 'subtraction': return 1 + Math.max(...ast.children.map(countTemporariesInExpression));
        case 'typedAssignment': return 1;
        case 'assignment': return 1;
        case 'callExpression': return 1;
        case 'ternary': return 2 + Math.max(
            countTemporariesInExpression(ast.children[0]),
            countTemporariesInExpression(ast.children[2]),
            countTemporariesInExpression(ast.children[4])
        );
        case 'equality': return 1 + Math.max(
            countTemporariesInExpression(ast.children[0]),
            countTemporariesInExpression(ast.children[2])
        );
        default: debugger;
    }
}

const countTemporariesInFunction = ({ statements }) => {
    return Math.max(...statements.map(countTemporariesInExpression));
}

const typesAreEqual = (a, b) => {
    if (!a || !b) debugger;
    if (a.name !== b.name) {
        return false;
    }
    return true;
}

const typeOfExpression = (foo, knownIdentifiers) => {
    const { type, children, value } = foo;
    switch (type) {
        case 'number': return { type: { name: 'Integer' }, errors: [] };
        case 'subtraction':
        case 'product': {
            const leftType = typeOfExpression(children[0], knownIdentifiers);
            const rightType = typeOfExpression(children[1], knownIdentifiers);
            if (leftType.errors.length > 0 || rightType.errors.length > 0) {
                return { type: {}, errors: leftType.errors.concat(rightType.errors) };
            }
            if (!typesAreEqual(leftType.type, { name: 'Integer' })) {
                return { type: {}, errors: [`Left hand side of ${type} was not integer`] };
            }
            if (!typesAreEqual(rightType.type, { name: 'Integer' })) {
                return { type: {}, errors: [`Right hand side of ${type} was not integer`] };
            }
            return { type: { name: 'Integer' }, errors: [] };
        }
        case 'equality': {
            const leftType = typeOfExpression(children[0], knownIdentifiers);
            const rightType = typeOfExpression(children[2], knownIdentifiers);
            if (leftType.errors.length > 0 || rightType.errors.length > 0) {
                return { type: {}, errors: leftType.errors.concat(rightType.errors) };
            }
            if (!typesAreEqual(leftType.type, { name: 'Integer' })) {
                return { type: {}, errors: [`Equality comparisons of Integers only. You tried to compare a ${leftType.type} (lhs)`] };
            }
            if (!typesAreEqual(rightType.type, { name: 'Integer' })) {
                return { type: {}, errors: [`Equality comparisons of Integers only. You tried to compare a ${rightType.type} (rhs)`] };
            }
            return { type: { name: 'Boolean' }, errors: [] };
        }
        case 'functionLiteral': {
            return { type: knownIdentifiers[value], errors: [] };
        }
        case 'callExpression': {
            const argType = typeOfExpression(children[2], knownIdentifiers);
            if (argType.errors.length > 0) {
                return argType;
            }
            const functionName = children[0].value;
            const functionType = knownIdentifiers[functionName];
            if (!typesAreEqual(argType.type, functionType.arg.type)) {
                return { type: {}, errors: [`You passed a ${argType.type.name} as an argument to ${functionName}. It expects a ${functionType.arg.type.name}`] };
            }
            return { type: { name: 'Integer' }, errors: [] };
        }
        case 'identifier': {
            if (value in knownIdentifiers) {
                return { type: knownIdentifiers[value], errors: [] };
            } else {
                return { type: {}, errors: [`Identifier ${value} has unknown type.`] };
            }
        }
        case 'ternary': {
            const conditionType = typeOfExpression(children[0], knownIdentifiers);
            const trueBranchType = typeOfExpression(children[2], knownIdentifiers);
            const falseBranchType = typeOfExpression(children[4], knownIdentifiers);
            if (conditionType.errors.length > 0 || trueBranchType.errors.length > 0 || falseBranchType.errors.length > 0) {
                return { type: {}, errors: conditionType.errors.concat(trueBranchType.errors).concat(falseBranchType.errors) };
            }
            if (!typesAreEqual(conditionType.type, { name: 'Boolean' })) {
                return { type: {}, errors: [`You tried to use a ${conditionType.type.name} as the condition in a ternary. Boolean is required`] };
            }
            if (!typesAreEqual(trueBranchType.type, falseBranchType.type)) {
                return { type: {}, errors: [`Type mismatch in branches of ternary. True branch had ${trueBranchType.type}, false branch had ${falseBranchType.type}.`] };
            }
            return { type: trueBranchType.type, errors: [] };
        };
        case 'booleanLiteral': return { type: { name: 'Boolean' }, errors: [] };
        default: debugger; return { type: {}, errors: [`Unknown type ${type}`] };
    }
};

const typeCheckStatement = ({ type, children }, knownIdentifiers) => {
    switch (type) {
        case 'returnStatement': {
            const result = typeOfExpression(children[1], knownIdentifiers);
            if (result.errors.length > 0) {
                return { errors: result.errors, newIdentifiers: {} };
            }
            if (!typesAreEqual(result.type, { name: 'Integer'})) {
                return { errors: [`You tried to return a ${result.type.name}`], newIdentifiers: {} };
            }
            return { errors: [], newIdentifiers: {} };
        }
        case 'assignment': {
            const rightType = typeOfExpression(children[2], knownIdentifiers);
            if (rightType.errors.length > 0) {
                return { errors: rightType.errors, newIdentifiers: {} };
            }
            // Left type is inferred as right type
            return { errors: [], newIdentifiers: { [children[0].value]: rightType } };
        }
        case 'typedAssignment': {
            // Check that type of var being assigned to matches type being assigned
            const varName = children[0].value;
            const rightType = typeOfExpression(children[4], knownIdentifiers);
            const leftType = { name: children[2].value };
            if (rightType.errors.length > 0) {
                return { errors: rightType.errors, newIdentifiers: {} };
            }
            if (!typesAreEqual(rightType.type, leftType)) {
                return { errors: [`You tried to assign a ${rightType.type.name} to "${varName}", which has type ${leftType.name}`], newIdentifiers: {} };
            }
            return { errors: [], newIdentifiers: { [varName]: { type: leftType } } };
        }
        default: debugger; return ['Unknown type'];
    };
};

const typeCheckProgram = ({ statements, argument }, previouslyKnownIdentifiers) => {
    let knownIdentifiers = Object.assign({}, previouslyKnownIdentifiers);

    if (argument) {
        knownIdentifiers[argument.children[0].value] = { name: argument.children[2].value };
    }

    allErrors = [];
    statements.forEach(s => {
        if (allErrors.length == 0) {
            const { errors, newIdentifiers } = typeCheckStatement(s, knownIdentifiers);
            for (identifier in newIdentifiers) {
                knownIdentifiers[identifier] = newIdentifiers[identifier].type;
            }
            allErrors.push(...errors);
        }
    });
    return { typeErrors: allErrors, identifiers: knownIdentifiers };
};

const getFunctionTypeMap = functions => {
    const result = {};
    functions.forEach(({ name, argument }) => {
        result[name] = { name: 'Function', arg: { type: { name: argument.children[2].value } } };
    });
    return result;
};

const compile = ({ source, target }) => {
    const tokens = lex(source);
    const { ast, parseErrors } = parse(tokens);

    if (parseErrors.length > 0) {
        return {
            code: '',
            parseErrors,
        };
    }

    const { functions, program } = extractFunctions(ast);

    const functionIdentifierTypes = getFunctionTypeMap(functions);

    const functionsWithStatementList = functions.map(statementTreeToStatementList);
    const programWithStatementList = statementTreeToStatementList({ body: program });

    const programTypeCheck = typeCheckProgram(programWithStatementList, functionIdentifierTypes);
    let typeErrors = functionsWithStatementList.map(f => typeCheckProgram(f, Object.assign({}, functionIdentifierTypes, programTypeCheck.identifiers)).typeErrors);
    typeErrors.push(programTypeCheck.typeErrors);

    typeErrors = flatten(typeErrors);
    if (typeErrors.length > 0) {
        return {
            typeErrors,
            parseErrors: [],
            code: '',
        };
    }

    const functionTemporaryCounts = functionsWithStatementList.map(countTemporariesInFunction);
    const programTemporaryCount = countTemporariesInFunction(programWithStatementList);

    const variables = flatten(programWithStatementList.statements.map(extractVariables));


    // Modifications here :(
    functionsWithStatementList.forEach((item, index) => {
        item.temporaryCount = functionTemporaryCounts[index];
    });
    programWithStatementList.temporaryCount = programTemporaryCount;

    globalDeclarations = programWithStatementList.statements
        .filter(s => s.type === 'assignment')
        .map(s => s.children[0].value);

    if (target == 'js') {
        return {
            typeErrors: [],
            parseErrors: [],
            code: toJS(functionsWithStatementList, variables, programWithStatementList, globalDeclarations),
        };
    } else if (target == 'c') {
        return {
            typeErrors: [],
            parseErrors: [],
            code: toC(functionsWithStatementList, variables, programWithStatementList, globalDeclarations),
        };
    } else if (target == 'mips') {
        return {
            typeErrors: [],
            parseErrors: [],
            code: toMips(functionsWithStatementList, variables, programWithStatementList, globalDeclarations),
        };
    }
};

module.exports = { parse, lex, compile };
