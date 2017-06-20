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
    return ${astToC(body)};
}`
    });
    let C = flatten(program.statements.map(astToC));
    debugger;

    return `
#include <stdio.h>

${Cfunctions.join('\n')}

int main(int argc, char **argv) {
    ${C.join('\n')}
}
`;
};

const astToJS = ast => {
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
    let JSfunctions = functions.map(({ name, argument, body }) => {
        return `
${name} = ${argument.value} => {
    return ${astToJS(body)};
};`
    });

    let JS = astToJS(program);
    return `
${JSfunctions.join('\n')}

${JS.join('\n')}
`;
};

const astToMips = (ast, registerAssignment) => {
    switch (ast.type) {
        case 'returnStatement': return [...astToMips(ast.children[1], registerAssignment), `
move $a0, $v0
li $v0, 1
syscall
li $v0, 10
syscall
`];
        case 'number': return [`
li $t1, ${ast.value}
`];
        case 'product': return [
            ...astToMips(ast.children[0], registerAssignment),
            ...astToMips(ast.children[1], registerAssignment),
            `
addiu $sp, $sp, 4
lw $t1, ($sp)
addiu $sp, $sp, 4
lw $t2, ($sp)
mult $t1, $t2
mflo $t1
sw $t1, ($sp)
addiu $sp, $sp -4
`,
        ];
        case 'statement': return flatten(ast.children.map(child => astToMips(child, registerAssignment)));
        case 'callExpression': {
            const name = ast.children[0].value;
            const register = registerAssignment[name];
            debugger;
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
    let mipsFunctions = functions.map(({ name, argument, body }) => {
        return `
${name}:
${astToMips(body, {})}
move $v0, $t1
jr $ra
`;
    });
    let mipsProgram = astToMips(program, registerAssignment);
    return `
.text
${mipsFunctions.join('\n')}
main:
${mipsProgram.join('\n')}
`;
}

module.exports = { toJS, toC, toMips };
