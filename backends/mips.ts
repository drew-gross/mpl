import flatten from '../util/list/flatten.js';

// 's' registers are used for the args, starting as 0. Spill recovery shall start at the last (7)

const storeLiteralMips = ({ type, destination, spOffset }, value) => {
    if (type == undefined) debugger;
    switch (type) {
        case 'register': return `li ${destination}, ${value}`;
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

const loadGlobalMips = ({ type, destination, spOffset }, value) => {
    switch (type) {
        case 'register': return `la ${destination}, ${value}`;
        default: debugger; return '';
    }
}

const multiplyMips = (destination, left, right) => {
    let leftRegister = left.destination;
    let loadSpilled: any = []
    let restoreSpilled: any = [];
    if (left.type == 'memory') {
        leftRegister = '$s1';
        loadSpilled.push(`lw $s1, -${left.spOffset}($sp)`);
    }

    let rightRegister = right.destination;
    if (right.type == 'memory') {
        rightRegister = '$s2';
        loadSpilled.push(`lw $s2, -${right.spOffset}($sp)`);
    }

    let destinationRegister = destination.destination;
    if (destination.type == 'memory') {
        destinationRegister = '$s3';
        restoreSpilled.push(`sw $s3, -${destination.spOffset}($sp)`);
    }
    if (leftRegister == '$tNaN') debugger;

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

type StorageSpec = { type: 'register', destination: string } | { type: 'memory', spOffset: number };

const nextTemporary = (storage: StorageSpec): StorageSpec => {
    if (storage.type == 'register') {
        if (storage.destination == '$t9') {
            // Now need to spill
            return {
                type: 'memory',
                spOffset: 0,
            };
        } else {
            return {
                type: 'register',
                destination: `$t${parseInt(storage.destination[storage.destination.length - 1]) + 1}`,
            };
        }
    } else if (storage.type == 'memory') {
        return {
            type: 'memory',
            spOffset: storage.spOffset + 4,
        }
    } else {
        debugger;
        throw 'debugger';
    }
};

const runtimeFunctions = ['length'];

let labelId = 0;

const astToMips = ({
    ast,
    registerAssignment,
    destination,
    currentTemporary,
    globalDeclarations,
    stringLiterals,
}) => {
    if (!ast) debugger;
    switch (ast.type) {
        case 'returnStatement': return [
            `# evaluate expression of return statement, put in $a0`,
            ...astToMips({
                ast: ast.children[1],
                registerAssignment,
                destination: {
                    type: 'register',
                    destination: '$a0',
                },
                currentTemporary,
                globalDeclarations,
                stringLiterals,
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
                stringLiterals,
            });
            const storeRightInstructions = astToMips({
                ast: ast.children[1],
                registerAssignment,
                destination: rightSideDestination,
                currentTemporary: subExpressionTemporary,
                globalDeclarations,
                stringLiterals,
            });
            return [
                `# Store left side of product in temporary (${leftSideDestination.destination})`,
                ...storeLeftInstructions,
                `# Store right side of product in destination (${rightSideDestination.destination})`,
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
                stringLiterals,
            });
            const storeRightInstructions = astToMips({
                ast: ast.children[1],
                registerAssignment,
                destination: rightSideDestination,
                currentTemporary: subExpressionTemporary,
                globalDeclarations,
                stringLiterals,
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
            stringLiterals,
        })));
        case 'callExpression': {
            if (currentTemporary.type !== 'register') debugger; // TODO: Figure out how to guarantee this doesn't happen
            const name = ast.children[0].value;
            let callInstructions: string[] = []
            if (runtimeFunctions.includes(name)) {
                callInstructions = [
                    `# Call runtime function`,
                    `la ${currentTemporary.destination}, ${name}`,
                    `jal ${currentTemporary.destination}`,
                ];
            } else if (globalDeclarations.includes(name)) {
                callInstructions = [
                    `# Call global function`,
                    `lw ${currentTemporary.destination}, ${name}`,
                    `jal ${currentTemporary.destination}`,
                ];
            } else if (name in registerAssignment) {
                callInstructions = [
                    `# Call register function`,
                    `jal ${registerAssignment[name].destination}`,
                ];
            } else {
                debugger;
            }

            return [
                `# Put argument in $s0`,
                ...astToMips({
                    ast: ast.children[2],
                    registerAssignment,
                    destination: { type: 'register', destination: '$s0' },
                    currentTemporary: nextTemporary(currentTemporary),
                    globalDeclarations,
                    stringLiterals,
                }),
                `# call ${name}`,
                ...callInstructions,
                `# move result from $a0 into destination`,
                moveMips(destination, '$a0'),
            ];
        }
        case 'typedAssignment': {
            const lhs = ast.children[0].value;
            if (globalDeclarations.includes(lhs)) {
                debugger; //TODO: assign to globals
            } else if (lhs in registerAssignment) {
                return [
                    `# Run rhs of assignment and store to ${lhs} (${registerAssignment[lhs].destination})`,
                    ...astToMips({
                        ast: ast.children[4],
                        registerAssignment,
                        // TODO: Allow spilling of variables
                        destination: {
                            type: 'register',
                            destination: `${registerAssignment[lhs].destination}`,
                        },
                        currentTemporary,
                        globalDeclarations,
                        stringLiterals,
                    }),
                ];
            } else {
                debugger;
            }
        }
        case 'assignment': {
            const lhs = ast.children[0].value;
            const rhs = ast.children[2].value;
            if (globalDeclarations.includes(lhs)) {
                return [
                    // TODO: Make assignment better
                    `# Load function ptr (${rhs} into s7 (s7 used to not overlap with arg)`,
                    `la $s7, ${rhs}`,
                    `# store from temporary into global`,
                    `sw $s7, ${lhs}`,
                ];
            } else {
                const register = registerAssignment[lhs].destination;
                return [
                    `# ${lhs} (${register}) = ${rhs}`,
                    `la ${register}, ${rhs}`,
                ];
            }
        }
        case 'identifier': {
            const identifierName = ast.value;
            const identifierRegister = registerAssignment[identifierName].destination;
            return [
                `# Move from ${identifierName} (${identifierRegister}) into destination (${destination.destination || destination.spOffset})`,
                moveMips(destination, identifierRegister),
            ];
        }
        case 'ternary': {
            const booleanTemporary = currentTemporary;
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
                    stringLiterals,
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
                    stringLiterals,
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
                    stringLiterals,
                }),
                `# End of ternary label`,
                `L${endOfTernaryLabel}:`,
            ];
        }
        case 'equality': {
            const leftSideDestination = currentTemporary;
            const rightSideDestination = destination;
            const subExpressionTemporary = nextTemporary(currentTemporary);

            const storeLeftInstructions = astToMips({
                ast: ast.children[0],
                registerAssignment,
                destination: leftSideDestination,
                currentTemporary: subExpressionTemporary,
                globalDeclarations,
                stringLiterals,
            });

            const storeRightInstructions = astToMips({
                ast: ast.children[2],
                registerAssignment,
                destination: rightSideDestination,
                currentTemporary: subExpressionTemporary,
                globalDeclarations,
                stringLiterals,
            });

            const equalLabel = labelId;
            labelId++;
            const endOfConditionLabel = labelId;
            labelId++;

            return [
                `# Store left side of equality in temporary`,
                ...storeLeftInstructions,
                `# Store right side of equality in temporary`,
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
        case 'stringLiteral': {
            debugger;
            return [
                `# Load string literal address into register`,
                loadGlobalMips(destination, ast.value),
            ];
        }
        default:
            debugger;
    }
}

const assignMipsRegisters = variables => {
    // TODO: allow spilling of variables
    let currentRegister = 0;
    let registerAssignment = {};
    variables.forEach(variable => {
        registerAssignment[variable] = {
            type: 'register',
            destination: `$t${currentRegister}`,
        };
        currentRegister = currentRegister + 1;
    });
    return {
        registerAssignment,
        firstTemporary: {
            type: 'register',
            destination: `$t${currentRegister}`,
        },
    };
};

const constructMipsFunction = ({ name, argument, statements, temporaryCount }, globalDeclarations, stringLiterals) => {
    const saveTemporariesCode = [
        `# Always store return address`,
        `sw $ra, ($sp)`,
        `addiu $sp, $sp, -4`,
    ];
    const restoreTemporariesCode = [
        `# Always restore return address`,
        `lw $ra, ($sp)`,
        `addiu $sp, $sp, 4`,
    ];

    const localsCount = statements.length - 1; // Statments are either assign or return right now

    while (temporaryCount + localsCount > 0) {
        saveTemporariesCode.push(`sw $t${temporaryCount}, ($sp)`);
        saveTemporariesCode.push(`addiu $sp, $sp, -4`);
        restoreTemporariesCode.push(`lw $t${temporaryCount}, ($sp)`);
        restoreTemporariesCode.push(`addiu $sp, $sp, 4`);
        temporaryCount--;
    }

    const registerAssignment: any = {
        [argument.children[0].value]: {
            type: 'register',
            destination: '$s0',
        },
    };

    let currentTemporary: StorageSpec = {
        type: 'register',
        destination: '$t1',
    };

    statements.forEach(statement => {
        if (statement.type === 'typedAssignment') {
            registerAssignment[statement.children[0].value] = currentTemporary;
            currentTemporary = nextTemporary(currentTemporary);
        }
    });

    const mipsCode = flatten(statements.map(statement => {
        return astToMips({
            ast: statement,
            registerAssignment,
            destination: '$a0',
            currentTemporary,
            globalDeclarations,
            stringLiterals,
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

export default (functions, variables, program, globalDeclarations, stringLiterals) => {
    let mipsFunctions = functions.map(f => constructMipsFunction(f,  globalDeclarations, stringLiterals));
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
        stringLiterals,
    })));

    // Create space for spilled tempraries
    const numSpilledTemporaries = program.temporaryCount - 10
    const makeSpillSpaceCode = numSpilledTemporaries > 0 ? [
        `# Make spill space for main program`,
        `addiu $sp, $sp, -${numSpilledTemporaries * 4}`,
    ] : [];
    const removeSpillSpaceCode = numSpilledTemporaries > 0 ? [
        `# Clean spill space for main program`,
        `addiu $sp, $sp, ${numSpilledTemporaries * 4}`,
    ] : [];

    return `
.data
${globalDeclarations.map(name => `${name}: .word 0`).join('\n')}
${stringLiterals.map(text => `${text}: .asciiz "${text}"`).join('\n')}

.text
length:
# Always store return address
sw $ra, ($sp)
addiu $sp, $sp, -4
# Store two temporaries
sw $t1, ($sp)
addiu $sp, $sp, -4
sw $t2, ($sp)
addiu $sp, $sp, -4

# Set length count to 0
li $t1, 0
length_loop:
# Load char into temporary
lb $t2, ($s0)
# If char is null, end of string. Return count.
beq $t2, 0, length_return
# Else bump pointer count and and return to start of loop
addiu $t1, $t1, 1
addiu $s0, $s0, 1
b length_loop

length_return:
# Put length in return register
move $a0, $t1

# Restore two temporaries
addiu $sp, $sp, 4
lw $t2, ($sp)
addiu $sp, $sp, 4
lw $t1, ($sp)
# Always restore return address
addiu $sp, $sp, 4
lw $ra, ($sp)
jr $ra

${mipsFunctions.join('\n')}
main:
${makeSpillSpaceCode.join('\n')}
${mipsProgram.join('\n')}
${removeSpillSpaceCode.join('\n')}
# print "exit code" and exit
li $v0, 1
syscall
li $v0, 10
syscall`;
}
