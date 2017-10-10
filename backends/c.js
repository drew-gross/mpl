const flatten = require('../util/list/flatten.js');

const mplTypeToCDeclaration = (type, identifier) => {
    switch (type) {
        case 'Function': return `unsigned char (*${identifier})(unsigned char)`
        case 'Integer': return `uint8_t ${identifier}`;
        default: debugger;
    }
};

const astToC = ({ ast, globalDeclarations }) => {
    if (!ast) debugger;
    switch (ast.type) {
        case 'returnStatement': return [
            `return`,
            ...astToC({ ast: ast.children[1], globalDeclarations }),
            ';',
        ];
        case 'number': return [ast.value.toString()];
        case 'product': {
            return [
                ...astToC({ ast: ast.children[0], globalDeclarations }),
                '*',
                ...astToC({ ast: ast.children[1], globalDeclarations }),
            ];
        }
        case 'subtraction': return [
            ...astToC({ ast: ast.children[0], globalDeclarations }),
            '-',
            ...astToC({ ast: ast.children[1], globalDeclarations }),
        ];
        case 'statement': return flatten(ast.children.map(child => astToC({ ast: child, globalDeclarations })));
        case 'statementSeparator': return [];
        case 'typedAssignment': {
            const lhs = ast.children[0].value;
            const rhs = astToC({ ast: ast.children[4], globalDeclarations });
            if (!globalDeclarations) debugger;
            if (globalDeclarations.includes(lhs)) {
                return [`${lhs} = `, ...rhs, `;`];
            }
            const lhsType = ast.children[2].value; // TODO: Not really type, just string :(
            return [`${mplTypeToCDeclaration(lhsType, lhs)} = `, ...rhs, ';'];
        }
        case 'assignment': {
            const lhs = ast.children[0].value
            const rhs = astToC({ ast: ast.children[2], globalDeclarations });
            if (!globalDeclarations) debugger;
            if (globalDeclarations.includes(lhs)) {
                return [`${lhs} = `, ...rhs, `;`];
            }

            return [`${mplTypeToCDeclaration('Function', lhs)} = `, ...rhs, `;`];
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

module.exports = (functions, variables, program, globalDeclarations) => {
    let Cfunctions = functions.map(({ name, argument, statements, scopeChain }) => {
        const prefix = `unsigned char ${name}(unsigned char ${argument.children[0].value}) {`;
        const suffix = `}`;

        const body = statements.map(statement => {
            return astToC({
                ast: statement,
                globalDeclarations,
            }).join(' ');
        });

        return [
            prefix,
            ...body,
            suffix,
        ].join(' ');
    });
    let C = flatten(program.statements.map(child => astToC({ ast: child, globalDeclarations })));
    let Cdeclarations = globalDeclarations.map(name => `unsigned char (*${name})(unsigned char);`);

    return `
#include <stdio.h>
#include <stdint.h>

${Cdeclarations.join('\n')}

${Cfunctions.join('\n')}

int main(int argc, char **argv) {
    ${C.join('\n')}
}
`;
};
