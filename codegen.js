const flatten = array => array.reduce((a, b) => a.concat(b), []);

const astToC = ({ ast, registerAssignment, destination, currentTemporary }) => {
    if (!ast) debugger;
    switch (ast.type) {
        case 'returnStatement': return [
            `return`,
            ...astToC({ ast: ast.children[1] }),
            ';',
        ];
        case 'number': return [ast.value.toString()];
        case 'product': return [
            ...astToC({ ast: ast.children[0] }),
            '*',
            ...astToC({ ast: ast.children[1] }),
        ];
        case 'subtraction': return [
            ...astToC({ ast: ast.children[0] }),
            '-',
            ...astToC({ ast: ast.children[1] }),
        ];
        case 'statement': return flatten(ast.children.map(child => astToC({ ast: child })));
        case 'statementSeparator': return [];
        case 'assignment': return [
            `unsigned char (*${ast.children[0].value})(unsigned char) = `,
            ...astToC({ ast: ast.children[2] }),
            `;`,
        ];
        case 'functionLiteral': return [`&${ast.value}`];
        case 'callExpression': return [
            `(*${ast.children[0].value})(`,
            ...astToC({ ast: ast.children[2] }),
            `)`,
        ];
        case 'identifier': return [ast.value];
        case 'ternary': return [
            ...astToC({ ast: ast.children[0] }),
            '?',
            ...astToC({ ast: ast.children[2] }),
            ':',
            ...astToC({ ast: ast.children[4] }),
        ];
        default:
            debugger;
            return;
    };
};

const toC = (functions, variables, program) => {
    let Cfunctions = functions.map(({ name, argument, statements }) => {
        const body = statements[0]; // TODO: support multiple statements in a function body
        return `
unsigned char ${name}(unsigned char ${argument.value}) {
    ${astToC({ ast: body }).join(' ')}
}`
    });
    let C = flatten(program.statements.map(child => astToC({ ast: child })));

    return `
#include <stdio.h>

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

const astToMips = ({ ast, registerAssignment, destination, currentTemporary }) => {
    if (!ast) debugger;
    switch (ast.type) {
        case 'returnStatement': return [
            `# evaluate expression of return statement, put in $a0`,
            ...astToMips({
                ast: ast.children[1],
                registerAssignment,
                destination: '$a0',
                currentTemporary,
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
                currentTemporary: subExpressionTemporary
            });
            const storeRightInstructions = astToMips({
                ast: ast.children[1],
                registerAssignment,
                destination: rightSideDestination,
                currentTemporary: subExpressionTemporary
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
            });
            const storeRightInstructions = astToMips({
                ast: ast.children[1],
                registerAssignment,
                destination: rightSideDestination,
                currentTemporary: subExpressionTemporary,
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
            currentTemporary
        })));
        case 'callExpression': {
            const name = ast.children[0].value;
            const register = registerAssignment[name];
            return [
                `# Put argument in $s0`,
                ...astToMips({
                    ast: ast.children[2],
                    registerAssignment,
                    destination: '$s0',
                    currentTemporary,
                }),
                `# call ${name} ($${register})`,
                `jal $${register}`,
                `# move result from $a0 into destination`,
                `move ${destination}, $a0`
            ];
        }
        case 'assignment': {
            const name = ast.children[0].value;
            const value = ast.children[2].value;
            const register = registerAssignment[name];
            return [
                `# ${name} ($${register}) = ${value}`,
                `la $${register}, ${value}`,
            ];
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
                }),
                `# Go to false branch if zero`,
                `beq ${booleanTemporary}, $0, L${falseBranchLabel}`,
                `# Execute true branch`,
                ...astToMips({
                    ast: ast.children[2],
                    registerAssignment,
                    destination,
                    currentTemporary: subExpressionTemporary,
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
                }),
                `# End of ternary label`,
                `L${endOfTernaryLabel}:`,
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

const constructMipsFunction = ({ name, argument, statements, temporaryCount }) => {
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
            currentTemporary: 1
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

const toMips = (functions, variables, program) => {
    let mipsFunctions = functions.map(constructMipsFunction);

    const {
        registerAssignment,
        firstTemporary,
    } = assignMipsRegisters(variables);
    let mipsProgram = flatten(program.statements.map(statement => astToMips({
        ast: statement,
        registerAssignment,
        destination: '$a0',
        currentTemporary: firstTemporary
    })));
    return `
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
