const flatten = array => array.reduce((a, b) => a.concat(b), []);

const astToC = ({ ast, registerAssignment, globalDeclarations }) => {
    if (!ast) debugger;
    switch (ast.type) {
        case 'returnStatement': return [
            `return`,
            ...astToC({ ast: ast.children[1], globalDeclarations }),
            ';',
        ];
        case 'number': return [ast.value.toString()];
        case 'product': return [
            ...astToC({ ast: ast.children[0], globalDeclarations }),
            '*',
            ...astToC({ ast: ast.children[1], globalDeclarations }),
        ];
        case 'subtraction': return [
            ...astToC({ ast: ast.children[0], globalDeclarations }),
            '-',
            ...astToC({ ast: ast.children[1], globalDeclarations }),
        ];
        case 'statement': return flatten(ast.children.map(child => astToC({ ast: child, globalDeclarations })));
        case 'statementSeparator': return [];
        case 'assignment': {
            const lhs = ast.children[0].value
            const rhs = astToC({ ast: ast.children[2], globalDeclarations });
            if (globalDeclarations.includes(lhs)) {
                return [
                    `${lhs} = `,
                    ...rhs,
                    `;`,
                ];
            }
            return [
                `unsigned char (*${lhs})(unsigned char) = `,
                ...rhs,
                `;`,
            ];
        }
        case 'functionLiteral': return [`&${ast.value}`];
        case 'callExpression': return [
            `(*${ast.children[0].value})(`,
            ...astToC({ ast: ast.children[2], globalDeclarations }),
            `)`,
        ];
        case 'identifier': return [ast.value];
        case 'ternary': return [
            ...astToC({ ast: ast.children[0], globalDeclarations }),
            '?',
            ...astToC({ ast: ast.children[2], globalDeclarations }),
            ':',
            ...astToC({ ast: ast.children[4], globalDeclarations }),
        ];
        case 'equality': return [
            ...astToC({ ast: ast.children[0], globalDeclarations }),
            '==',
            ...astToC({ ast: ast.children[2], globalDeclarations }),
        ];
        default:
            debugger;
            return;
    };
};

const toC = (functions, variables, program, globalDeclarations) => {
    let Cfunctions = functions.map(({ name, argument, statements, scopeChain }) => {
        const body = statements[0]; // TODO: support multiple statements in a function body
        return `
unsigned char ${name}(unsigned char ${argument.value}) {
    ${astToC({ ast: body }).join(' ')}
}`
    });
    let C = flatten(program.statements.map(child => astToC({ ast: child, globalDeclarations })));
    let Cdeclarations = globalDeclarations.map(name => `unsigned char (*${name})(unsigned char);`);

    return `
#include <stdio.h>

${Cdeclarations.join('\n')}

${Cfunctions.join('\n')}

int main(int argc, char **argv) {
    ${C.join('\n')}
}
`;
};

const astToJS = ({ ast, registerAssignment, destination, currentTemporary }) => {
    if (!ast) debugger;
    switch (ast.type) {
        case 'returnStatement': return [
            `${destination} = `,
            ...astToJS({
                ast: ast.children[1],
                destination,
            }),
        ];
        case 'number': return [ast.value.toString()];
        case 'product': return [
            ...astToJS({
                ast: ast.children[0],
                destination,
            }),
            '*',
            ...astToJS({
                ast: ast.children[1],
                destination
            }),
        ];
        case 'subtraction': return [
            ...astToJS({
                ast: ast.children[0],
                destination,
            }),
            '-',
            ...astToJS({
                ast: ast.children[1],
                destination
            }),
        ];
        case 'statement': return flatten(ast.children.map(child => astToJS({
            ast: child,
            destination,
        })));
        case 'statementSeparator': return [];
        case 'assignment': return [
            `const ${ast.children[0].value} = `,
            ...astToJS({
                ast: ast.children[2],
                destination
            }),
            ';',
        ]
        case 'functionLiteral': return [ast.value];
        case 'callExpression': return [
            `${ast.children[0].value}(`,
            ...astToJS({ ast: ast.children[2] }),
            `)`];
        case 'identifier': return [ast.value];
        case 'ternary': return [
            ...astToJS({ ast: ast.children[0] }),
            '?',
            ...astToJS({ ast: ast.children[2] }),
            ':',
            ...astToJS({ ast: ast.children[4] }),
        ];
        case 'equality': return [
            ...astToJS({ ast: ast.children[0] }),
            '==',
            ...astToJS({ ast: ast.children[2] }),
        ];
        default:
            debugger;
            return;
    }
};

const toJS = (functions, variables, program) => {
    let JSfunctions = functions.map(({ name, argument, statements }) => {
        return `
${name} = ${argument.value} => {
    ${astToJS({ ast: statements[0], destination: 'retVal' }).join(' ')}
    return retVal;
};`
    });

    let JS = flatten(program.statements.map(child => astToJS({
        ast: child,
        destination: 'exitCode',
    })));
    return `
${JSfunctions.join('\n')}

${JS.join('\n')}
process.exit(exitCode);`;
};

const nextTemporary = currentTemporary => currentTemporary + 1; // Don't use more temporaries than there are registers! :p

let labelId = 0;

const astToMips = ({ ast, registerAssignment, destination, currentTemporary, globalDeclarations }) => {
    if (!ast) debugger;
    switch (ast.type) {
        case 'returnStatement': return [
            `# evaluate expression of return statement, put in $a0`,
            ...astToMips({
                ast: ast.children[1],
                registerAssignment,
                destination: '$a0',
                currentTemporary,
                globalDeclarations,
            }),
        ];
        case 'number': return [`li ${destination}, ${ast.value}\n`];
        case 'product': {
            const leftSideDestination = `$t${currentTemporary}`;
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
                `# Store left side in temporary (${leftSideDestination})\n`,
                ...storeLeftInstructions,
                `# Store right side in destination (${rightSideDestination})\n`,
                ...storeRightInstructions,
                `# Evaluate product`,
                `mult ${leftSideDestination}, ${rightSideDestination}`,
                `# Move result to final destination (assume no overflow)`,
                `mflo ${destination}`,
            ];
        }
        case 'subtraction': {
            const leftSideDestination = `$t${currentTemporary}`;
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
                `# Store left side in temporary (${leftSideDestination})\n`,
                ...storeLeftInstructions,
                `# Store right side in destination (${rightSideDestination})\n`,
                ...storeRightInstructions,
                `# Evaluate subtraction`,
                `sub ${destination}, ${leftSideDestination}, ${rightSideDestination}`,
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
                    destination: '$s0',
                    currentTemporary: nextTemporary(currentTemporary),
                    globalDeclarations,
                }),
                `# call ${name}`,
                ...callInstructions,
                `# move result from $a0 into destination`,
                `move ${destination}, $a0`
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
                `move ${destination}, ${identifierRegister}`,
            ];
        }
        case 'ternary': {
            const booleanTemporary = `$t${currentTemporary}`;
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
                `beq ${booleanTemporary}, $0, L${falseBranchLabel}`,
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
            const leftSideDestination = `$t${currentTemporary}`;
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
                `beq ${leftSideDestination}, ${rightSideDestination}, L${equalLabel}`,
                `# Not equal, set 0`,
                `li ${destination}, 0`,
                `# And goto exit`,
                `b L${endOfConditionLabel}`,
                `L${equalLabel}:`,
                `li ${destination}, 1`,
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
        firstTemporary: currentRegister,
    };
};

const constructMipsFunction = ({ name, argument, statements, temporaryCount }, globalDeclarations) => {
    const saveTemporariesCode = [];
    const restoreTemporariesCode = [];
    while (temporaryCount >= 0) {
        saveTemporariesCode.push(`sw $t${temporaryCount}, ($sp)`);
        saveTemporariesCode.push(`addiu $sp, $sp, -4`);
        restoreTemporariesCode.push(`lw $t${temporaryCount}, ($sp)`);
        restoreTemporariesCode.push(`addiu $sp, $sp, 4`);
        temporaryCount--;
    }

    const mipsCode = flatten(statements.map(statement => {
        const registerAssignment = {
            [argument.value]: '$s0',
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

const toMips = (functions, variables, program, globalDeclarations) => {
    let mipsFunctions = functions.map(f => constructMipsFunction(f,  globalDeclarations));

    const {
        registerAssignment,
        firstTemporary,
    } = assignMipsRegisters(variables);
    let mipsProgram = flatten(program.statements.map(statement => astToMips({
        ast: statement,
        registerAssignment,
        destination: '$a0',
        currentTemporary: firstTemporary,
        globalDeclarations
    })));

    return `
.data
${globalDeclarations.map(name => `${name}: .word 0`).join('\n')}
.text
${mipsFunctions.join('\n')}
main:
${mipsProgram.join('\n')}
# print "exit code" and exit
li $v0, 1
syscall
li $v0, 10
syscall`;
}

module.exports = { toJS, toC, toMips };
