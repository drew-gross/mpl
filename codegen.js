const flatten = array => array.reduce((a, b) => a.concat(b), []);

const astToC = ast => {
    switch (ast.type) {
        case 'returnStatement': return [
            `return`,
            ...astToC(ast.children[1]),
            ';',
        ];
        case 'number': return [ast.value.toString()];
        case 'product': return [
            ...astToC(ast.children[0]),
            '*',
            ...astToC(ast.children[1]),
        ];
        case 'statement': return flatten(ast.children.map(astToC));
        case 'statementSeparator': return [];
        case 'assignment': return [
            `unsigned char (*${ast.children[0].value})(unsigned char) = `,
            ...astToC(ast.children[2]),
            `;`,
        ];
        case 'functionLiteral': return [`&${ast.value}`];
        case 'callExpression': return [`(*${ast.children[0].value})(0)`]; // Args unused for now >.<
        default:
            debugger;
            return;
    };
};

const toC = (functions, variables, program) => {
    let Cfunctions = functions.map(({ name, argument, statements }) => {
        const body = statements[0]; // TOOD: support multiple statements in a function body
        return `
unsigned char ${name}(unsigned char ${argument.value}) {
    ${astToC(body).join(' ')}
}`
    });
    let C = flatten(program.statements.map(astToC));

    return `
#include <stdio.h>

${Cfunctions.join('\n')}

int main(int argc, char **argv) {
    ${C.join('\n')}
}
`;
};

const astToJS = ast => {
    if (!ast) debugger;
    switch (ast.type) {
        case 'returnStatement': return [
            `process.exit(`,
            ...astToJS(ast.children[1]),
            `);`,
        ];
        case 'number': return [ast.value.toString()];
        case 'product': return [
            ...astToJS(ast.children[0]),
            '*',
            ...astToJS(ast.children[1]),
        ];
        case 'statement': return flatten(ast.children.map(astToJS));
        case 'statementSeparator': return [];
        case 'assignment': return [
            `const ${ast.children[0].value} = `,
            ...astToJS(ast.children[2]),
            ';',
        ]
        case 'functionLiteral': return [ast.value];
        case 'callExpression': return [`${ast.children[0].value}()`]; // No args for now >.<
        default:
            debugger;
            return;
    }
};

const toJS = (functions, variables, program) => {
    let JSfunctions = functions.map(({ name, argument, statements }) => {
        return `
${name} = ${argument.value} => {
    return ${astToJS(statements[0]).join(' ')};
};`
    });

    let JS = flatten(program.statements.map(astToJS));
    return `
${JSfunctions.join('\n')}

${JS.join('\n')}
`;
};

const nextTemporary = currentTemporary => currentTemporary + 1; // Don't use more temporaries than there are registers! :p

const astToMips = (ast, registerAssignment, destination, currentTemporary) => {
    if (!ast) debugger;
    switch (ast.type) {
        case 'returnStatement': {
            if (ast.children[1].type === 'number') {
                return `# load constant into return register
li $a0, ${ast.children[1].value}\n`;
            } else if (ast.children[1].type === 'callExpression') {
                return [
`# call function, return val already in $a0
${astToMips(ast.children[1], registerAssignment, 'unused', currentTemporary)}\n`]
            } else if (ast.children[1].type === 'product') {
                return astToMips(ast.children[1], registerAssignment, '$a0', currentTemporary);
            } else {
                debugger;
            }
            return [putRetvalIntoA0];
        }
        case 'number': return [`li ${destination}, ${ast.value}\n`];
        case 'product': {
            const leftSideDestination = destination;
            const rightSideDestination = `$t${currentTemporary}`;
            const subExpressionTemporary = nextTemporary(currentTemporary);
            return [
            `# Store left side in destination (${leftSideDestination})\n`,
            ...astToMips(ast.children[0], registerAssignment, leftSideDestination, subExpressionTemporary),
            `# Store right side in temporary (${rightSideDestination})\n`,
            ...astToMips(ast.children[1], registerAssignment, rightSideDestination, subExpressionTemporary),
`# Evaluate product
mult ${leftSideDestination}, ${rightSideDestination}
# Move result to final destination (assume no overflow)
mflo ${destination}\n`,
        ];
        }
        case 'statement': return flatten(ast.children.map(child => astToMips(child, registerAssignment, '(TODO: READ FROM REGISTER ASSIGNMENT)', currentTemporary)));
        case 'callExpression': {
            const name = ast.children[0].value;
            const register = registerAssignment[name];
            return [
`# call ${name} ($${register})
jal $${register}
`];
        }
        case 'assignment': {
            const name = ast.children[0].value;
            const value = ast.children[2].value;
            const register = registerAssignment[name];
            return [
`# ${name} ($${register}) = ${value}
la $${register}, ${value}
`]
        }
        default:
            debugger;
    }
}

const assignMipsRegisters = variables => {
    let currentRegister = 0;
    let result = {};
    variables.forEach(variable => {
        result[variable] = `t${currentRegister}`;
        currentRegister = currentRegister + 1;
    });
    return result;
};

const toMips = (functions, variables, program) => {
    let registerAssignment = assignMipsRegisters(variables);
    let mipsFunctions = functions.map(({ name, argument, statements }) => {
        let mipsCode = flatten(statements.map(statement => astToMips(statement, {}, '$a0', 0)));
        return `
${name}:
${mipsCode}
jr $ra
`;
    });
    let mipsProgram = flatten(program.statements.map(statement => astToMips(statement, registerAssignment, '$a0', 0)));
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
