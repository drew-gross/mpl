const flatten = require('../util/list/flatten.js');

// 's' registers are used for the, starting as 0. Spill recovery shall start at the last (7)

const storeLiteralMips = ({ type, destination, spOffset }, value) => {
    if (type == undefined) debugger;
    switch (type) {
        case 'register': return `li $t${destination}, ${value}`;
        case 'memory': return [
            `li $s7, ${value}`,
            `sw $s7, -${spOffset}($sp)`
        ].join('\n');
        default: debugger; return '';
    }
}

const subtractMips = ({ type, destination }, left, right) => {
    switch (type) {
        case 'register': return `sub ${destination}, ${left.destination}, ${right.destination}`;
        default: debugger; return '';
    }
}

const moveMips = ({ type, destination }, source) => {
    switch (type) {
        case 'register': return `move ${destination}, ${source}`;
        default: debugger; return '';
    }
}

const multiplyMips = (destination, left, right) => {
    let leftRegister = `$t${left.destination}`;
    let loadSpilled = []
    let restoreSpilled = [];
    if (left.type == 'memory') {
        leftRegister = '$s1';
        loadSpilled.push(`lw $s1, -${left.spOffset}($sp)`);
    }

    let rightRegister = `$t${right.destination}`;
    if (right.type == 'memory') {
        rightRegister = '$s2';
        loadSpilled.push(`lw $s2, -${right.spOffset}($sp)`);
    }

    let destinationRegister = `$t${destination.destination}`;
    if (destination.type == 'memory') {
        destinationRegister = '$s3';
        restoreSpilled.push(`sw $s3, -${destination.spOffset}($sp)`);
    }

    return [
        ...loadSpilled,
        `mult ${leftRegister}, ${rightRegister}`,
        `# Move result to final destination (assume no overflow)`,
        `mflo ${destinationRegister}`,
        ...restoreSpilled,
    ].join('\n');
}

const mipsBranchIfEqual = (left, right, label) => {
    if (left.type !== 'register' || right.type !== 'register') debugger;
    return `beq ${left.destination}, ${right.destination}, ${label}`
}

const nextTemporary = ({ type, destination, spOffset }) => {
    if (type == 'register') {
        if (destination == 9) {
            // Now need to spill
            return {
                type: 'memory',
                spOffset: 0,
            };
        } else {
            return {
                type: 'register',
                destination: destination + 1,
            };
        }
    } else if (type == 'memory') {
        return {
            type: 'memory',
            spOffset: spOffset + 4,
        }
    } else {
        debugger;
    }
};

let labelId = 0;

const astToMips = ({ ast, registerAssignment, destination, currentTemporary, globalDeclarations }) => {
    if (!ast) debugger;
    switch (ast.type) {
        case 'returnStatement': return [
            `# evaluate expression of return statement, put in $a0`,
            ...astToMips({
                ast: ast.children[1],
                registerAssignment,
                destination: {
                    type: 'register',
                    destination: 0,
                },
                currentTemporary,
                globalDeclarations,
            }),
        ];
        case 'number': return [storeLiteralMips(destination, ast.value)];
        case 'booleanLiteral': return [storeLiteralMips(destination, ast.value == 'true' ? '1' : '0')];
        case 'product': {
            const leftSideDestination = currentTemporary;
            const rightSideDestination = destination;
            const subExpressionTemporary = nextTemporary(currentTemporary);

            const storeLeftInstructions = astToMips({
                ast: ast.children[0],
                registerAssignment,
                destination: leftSideDestination,
                currentTemporary: subExpressionTemporary,
                globalDeclarations,
            });
            const storeRightInstructions = astToMips({
                ast: ast.children[1],
                registerAssignment,
                destination: rightSideDestination,
                currentTemporary: subExpressionTemporary,
                globalDeclarations,
            });
            return [
                `# Store left side in temporary (${leftSideDestination.destination})\n`,
                ...storeLeftInstructions,
                `# Store right side in destination (${rightSideDestination.destination})\n`,
                ...storeRightInstructions,
                `# Evaluate product`,
                multiplyMips(destination, leftSideDestination, rightSideDestination),
            ];
        }
        case 'subtraction': {
            const leftSideDestination = currentTemporary;
            const rightSideDestination = destination;
            const subExpressionTemporary = nextTemporary(currentTemporary);

            const storeLeftInstructions = astToMips({
                ast: ast.children[0],
                registerAssignment,
                destination: leftSideDestination,
                currentTemporary: subExpressionTemporary,
                globalDeclarations,
            });
            const storeRightInstructions = astToMips({
                ast: ast.children[1],
                registerAssignment,
                destination: rightSideDestination,
                currentTemporary: subExpressionTemporary,
                globalDeclarations,
            });
            return [
                `# Store left side in temporary (${leftSideDestination.destination})`,
                ...storeLeftInstructions,
                `# Store right side in destination (${rightSideDestination.destination})`,
                ...storeRightInstructions,
                `# Evaluate subtraction`,
                subtractMips(destination, leftSideDestination, rightSideDestination),
            ];
        }
        case 'statement': return flatten(ast.children.map(child => astToMips({
            ast: child,
            registerAssignment,
            destination: '(TODO: READ FROM REGISTER ASSIGNMENT)',
            currentTemporary,
            globalDeclarations,
        })));
        case 'callExpression': {
            const name = ast.children[0].value;
            const callInstructions = globalDeclarations.includes(name)
                ? [`lw $t${currentTemporary}, ${name}`, `jal $t${currentTemporary}`]
                : [`jal $${registerAssignment[name]}`];

            return [
                `# Put argument in $s0`,
                ...astToMips({
                    ast: ast.children[2],
                    registerAssignment,
                    destination: { type: 'register', destination: '$s0' },
                    currentTemporary: nextTemporary(currentTemporary),
                    globalDeclarations,
                }),
                `# call ${name}`,
                ...callInstructions,
                `# move result from $a0 into destination`,
                moveMips(destination, '$a0'),
            ];
        }
        case 'assignment': {
            const lhs = ast.children[0].value;
            const rhs = ast.children[2].value;
            if (globalDeclarations.includes(lhs)) {
                return [
                    `# Load function ptr (${rhs} into current temporary ($${currentTemporary})`,
                    `la $t${currentTemporary}, ${rhs}`,
                    `# store from temporary into global`,
                    `sw $t${currentTemporary}, ${lhs}`,
                ];
            } else {
                const register = registerAssignment[lhs];
                return [
                    `# ${lhs} ($${register}) = ${rhs}`,
                    `la $${register}, ${rhs}`,
                ];
            }
        }
        case 'identifier': {
            const identifierName = ast.value;
            const identifierRegister = registerAssignment[identifierName];
            return [
                `# Move from ${identifierName} (${identifierRegister}) into destination (${destination})`,
                moveMips(destination, identifierRegister),
            ];
        }
        case 'ternary': {
            const booleanTemporary = {
                type: 'register',
                destination: `$t${currentTemporary}`,
            };
            const subExpressionTemporary = nextTemporary(currentTemporary);
            const falseBranchLabel = labelId;
            labelId++;
            const endOfTernaryLabel = labelId;
            labelId++;
            return [
                `# Compute boolean and store in temporary`,
                ...astToMips({
                    ast: ast.children[0],
                    registerAssignment,
                    destination: booleanTemporary,
                    currentTemporary: subExpressionTemporary,
                    globalDeclarations,
                }),
                `# Go to false branch if zero`,
                mipsBranchIfEqual(booleanTemporary, { type: 'register', destination: '$0' }, `L${falseBranchLabel}`),
                `# Execute true branch`,
                ...astToMips({
                    ast: ast.children[2],
                    registerAssignment,
                    destination,
                    currentTemporary: subExpressionTemporary,
                    globalDeclarations,
                }),
                `# Jump to end of ternary`,
                `b L${endOfTernaryLabel}`,
                `L${falseBranchLabel}:`,
                `# Execute false branch`,
                ...astToMips({
                    ast: ast.children[4],
                    registerAssignment,
                    destination,
                    currentTemporary: subExpressionTemporary,
                    globalDeclarations,
                }),
                `# End of ternary label`,
                `L${endOfTernaryLabel}:`,
            ];
        }
        case 'equality': {
            const leftSideDestination = {
                type: 'register',
                destination: `$t${currentTemporary}`
            };
            const rightSideDestination = destination;
            const subExpressionTemporary = nextTemporary(currentTemporary);

            const storeLeftInstructions = astToMips({
                ast: ast.children[0],
                registerAssignment,
                destination: leftSideDestination,
                currentTemporary: subExpressionTemporary,
                globalDeclarations,
            });

            const storeRightInstructions = astToMips({
                ast: ast.children[2],
                registerAssignment,
                destination: rightSideDestination,
                currentTemporary: subExpressionTemporary,
                globalDeclarations,
            });

            const equalLabel = labelId;
            labelId++;
            const endOfConditionLabel = labelId;
            labelId++;

            return [
                `# Store left side in temporary`,
                ...storeLeftInstructions,
                `# Store right side in temporary`,
                ...storeRightInstructions,
                `# Goto set 1 if equal`,
                mipsBranchIfEqual(leftSideDestination, rightSideDestination, `L${equalLabel}`),
                `# Not equal, set 0`,
                storeLiteralMips(destination, '0'),
                `# And goto exit`,
                `b L${endOfConditionLabel}`,
                `L${equalLabel}:`,
                storeLiteralMips(destination, '1'),
                `L${endOfConditionLabel}:`,
            ];
        }
        default:
            debugger;
    }
}

const assignMipsRegisters = variables => {
    let currentRegister = 0;
    let registerAssignment = {};
    variables.forEach(variable => {
        registerAssignment[variable] = `t${currentRegister}`;
        currentRegister = currentRegister + 1;
    });
    return {
        registerAssignment,
        firstTemporary: { // TODO: This assumes we never need to spill locals
            type: 'register',
            destination: currentRegister
        },
    };
};

const constructMipsFunction = ({ name, argument, statements, temporaryCount }, globalDeclarations) => {
    const saveTemporariesCode = [
        // Always store return address
        `sw $ra, ($sp)`,
        `addiu $sp, $sp, -4`,
    ];
    const restoreTemporariesCode = [
        // Always restore return address
        `lw $ra, ($sp)`,
        `addiu $sp, $sp, 4`,
    ];
    while (temporaryCount > 0) {
        saveTemporariesCode.push(`sw $t${temporaryCount}, ($sp)`);
        saveTemporariesCode.push(`addiu $sp, $sp, -4`);
        restoreTemporariesCode.push(`lw $t${temporaryCount}, ($sp)`);
        restoreTemporariesCode.push(`addiu $sp, $sp, 4`);
        temporaryCount--;
    }

    const mipsCode = flatten(statements.map(statement => {
        const registerAssignment = {
            [argument.children[0].value]: '$s0',
        };
        return astToMips({
            ast: statement,
            registerAssignment,
            destination: '$a0',
            currentTemporary: 1,
            globalDeclarations,
        });
    }));
    return [
        `${name}:`,
        ...saveTemporariesCode,
        `${mipsCode.join('\n')}`,
        ...restoreTemporariesCode.reverse(),
        `jr $ra`,
    ].join('\n');
}

module.exports = (functions, variables, program, globalDeclarations) => {
    let mipsFunctions = functions.map(f => constructMipsFunction(f,  globalDeclarations));
    const {
        registerAssignment,
        firstTemporary,
    } = assignMipsRegisters(variables);
    let mipsProgram = flatten(program.statements.map(statement => astToMips({
        ast: statement,
        registerAssignment,
        destination: {
            type: 'register',
            destination: '$a0',
        },
        currentTemporary: firstTemporary,
        globalDeclarations,
    })));

    // Create space for spilled tempraries
    const numSpilledTemporaries = program.temporaryCount - 10
    const makeSpillSpaceCode = ``;
    const removeSpillSpaceCode = ``;

    return `
.data
${globalDeclarations.map(name => `${name}: .word 0`).join('\n')}
.text
${mipsFunctions.join('\n')}
main:
# Make spill space for main program
addiu $sp, $sp, -${numSpilledTemporaries * 4}
${mipsProgram.join('\n')}
# Clean spill space for main program
addiu $sp, $sp, ${numSpilledTemporaries * 4}
# print "exit code" and exit
li $v0, 1
syscall
li $v0, 10
syscall`;
}
