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

const toC = (functions, program) => {
    let Cfunctions = functions.map(({ name, argument, body }) => {
        return `
unsigned char ${name}(unsigned char ${argument.value}) {
    return ${astToC(body)};
}`
    });
    let C = astToC(program);

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

const toJS = (functions, program) => {
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

const astToMips = ast => {
    switch (ast.type) {
        case 'returnStatement': return [...astToMips(ast.children[1]), `
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
            ...astToMips(ast.children[0]),
            ...astToMips(ast.children[1]),
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
        case 'statement': return flatten(ast.children.map(astToMips));
        case 'callExpression': debugger; return [`
# la $t1, $t1
jal $t1
`];
        case 'assignment': return [
`# $t1 = ${ast.children[0].value}
la $t1, ${ast.children[2].value}
`]
        default:
            debugger;
    }
}

const toMips = (functions, program) => {
    let mipsFunctions = functions.map(({ name, argument, body }) => {
        return `
${name}:
${astToMips(body)}
move $v0, $t1
jr $ra
`;
    });
    let mipsProgram = astToMips(program);
    return `
.text
${mipsFunctions.join('\n')}
main:
${mipsProgram.join('\n')}
`;
}

module.exports = { toJS, toC, toMips };
