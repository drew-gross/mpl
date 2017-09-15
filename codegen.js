const flatten = require('./util/list/flatten.js');
const toMips = require('./backends/mips.js');

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
        case 'booleanLiteral': return [ast.value == 'true' ? '1' : '0'];
        default:
            debugger;
            return;
    };
};

const toC = (functions, variables, program, globalDeclarations) => {
    let Cfunctions = functions.map(({ name, argument, statements, scopeChain }) => {
        const body = statements[0]; // TODO: support multiple statements in a function body
        return `
unsigned char ${name}(unsigned char ${argument.children[0].value}) {
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
        case 'booleanLiteral': return [ast.value];
        default:
            debugger;
            return;
    }
};

const toJS = (functions, variables, program) => {
    let JSfunctions = functions.map(({ name, argument, statements }) => {
        return `
${name} = ${argument.children[0].value} => {
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

module.exports = { toJS, toC, toMips };
