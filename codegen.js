const flatten = array => array.reduce((a, b) => a.concat(b), []);

const astToC = ast => {
    switch (ast.type) {
        case 'returnStatement': return [
            ...astToC(ast.children[1]),
            `return stack[0];`
        ];
        case 'number': return [`stack[stackSize] = ${ast.value}; stackSize++;`];
        case 'product1': return [
            ...astToC(ast.children[0]),
            ...astToC(ast.children[2]),
            `{
                char tmp1 = stack[stackSize - 1]; stackSize--;
                char tmp2 = stack[stackSize - 1]; stackSize--;
                stack[stackSize] = tmp1 + tmp2; stackSize++;
            }`
        ];
        case 'statement': return flatten(ast.children.map(astToC));
        case 'assignment': return [
            ...astToC(ast.children[2]),
            `{ unsigned char ${ast.children[0].value} = stack[stackSize - 1]; stackSize--; }`];
        default:
            debugger;
            return;
    };
};

const toC = ast => {
    let C = astToC(ast);

    return `
#include <stdio.h>

int main(int argc, char **argv) {
    char stack[255];
    char stackSize = 0;
    ${C.join('\n')}
}
`;
};

const astToJS = ast => {
    switch (ast.type) {
        case 'returnStatement': return [...astToJS(ast.children[1]), `process.exit(stack[0]);`];
        case 'number': return [`stack.push(${ast.value});`];
        case 'product1': return [
            ...astToJS(ast.children[0]),
            ...astToJS(ast.children[2]),
            `{ let tmp1 = stack.pop(); let tmp2 = stack.pop(); stack.push(tmp1 * tmp2); }`,
        ];
        case 'statement': return flatten(ast.children.map(astToJS));
        case 'assignment': return [
            ...astToJS(ast.children[2]),
            `{ let ${ast.children[0].value} = stack.pop(); }`,
        ]
        default:
            debugger;
            return;
    }
};

const toJS = ast => {
    let JS = astToJS(ast);
    return `
let stack = [];
${JS.join('\n')}
`;
};

const astToMips = ast => {
    switch (ast.type) {
        case 'returnStatement': return [...astToMips(ast.children[1]), `
li $v0, 1
syscall
li $v0, 10
syscall
`];
        case 'number': return [`li $a0, ${ast.value}`];
    }
}

const toMips = ast => {
    let mips = astToMips(ast);
    return `
.text
main:
${mips.join('\n')}
`;
}

module.exports = { toJS, toC, toMips };
