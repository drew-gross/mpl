import flatten from '../util/list/flatten.js';
import { VariableDeclaration, Type, BackendInputs } from '../compiler.js';

const mplTypeToCDeclaration = (type: Type, name: string) => {
    if (!type) debugger;
    switch (type.name) {
        case 'Function': return `unsigned char (*${name})(unsigned char)`
        case 'Integer': return `uint8_t ${name}`;
        case 'String': return `char *${name}`;
        default: debugger;
    }
};

type BackendInput = {
    ast: any,
    globalDeclarations: VariableDeclaration[],
    stringLiterals: string[],
};

const astToC = ({ ast, globalDeclarations, stringLiterals }: BackendInput): string[] => {
    if (!ast) debugger;
    switch (ast.type) {
        case 'returnStatement': return [
            `return`,
            ...astToC({ ast: ast.children[1], globalDeclarations, stringLiterals }),
            ';',
        ];
        case 'number': return [ast.value.toString()];
        case 'product': {
            return [
                ...astToC({ ast: ast.children[0], globalDeclarations, stringLiterals }),
                '*',
                ...astToC({ ast: ast.children[1], globalDeclarations, stringLiterals }),
            ];
        }
        case 'subtraction': return [
            ...astToC({ ast: ast.children[0], globalDeclarations, stringLiterals }),
            '-',
            ...astToC({ ast: ast.children[1], globalDeclarations, stringLiterals }),
        ];
        case 'statement': return flatten(ast.children.map(child => astToC({ ast: child, globalDeclarations, stringLiterals })));
        case 'statementSeparator': return [];
        case 'typedAssignment': {
            const lhs = ast.children[0].value;
            const rhs = astToC({ ast: ast.children[4], globalDeclarations, stringLiterals });
            if (!globalDeclarations) debugger;
            if (globalDeclarations.map(({ name }: { name: string }) => name).includes(lhs)) {
                return [`${lhs} = `, ...rhs, `;`];
            }
            const lhsType = ast.children[2].value; // TODO: Not really type, just string :(
            return [`${mplTypeToCDeclaration({ name: lhsType }, lhs)} = `, ...rhs, ';'];
        }
        case 'assignment': {
            const lhs = ast.children[0].value
            const rhs = astToC({ ast: ast.children[2], globalDeclarations, stringLiterals });
            if (!globalDeclarations) debugger;
            if (globalDeclarations.map(({ name }: { name: string }) => name).includes(lhs)) {
                return [`${lhs} = `, ...rhs, `;`];
            }
            return [`${mplTypeToCDeclaration({ name: 'Function' } as any, lhs)} = `, ...rhs, `;`];
        }
        case 'functionLiteral': return [`&${ast.value}`];
        case 'callExpression': return [
            `(*${ast.children[0].value})(`,
            ...astToC({ ast: ast.children[2], globalDeclarations, stringLiterals }),
            `)`,
        ];
        case 'identifier': return [ast.value];
        case 'ternary': return [
            ...astToC({ ast: ast.children[0], globalDeclarations, stringLiterals }),
            '?',
            ...astToC({ ast: ast.children[2], globalDeclarations, stringLiterals }),
            ':',
            ...astToC({ ast: ast.children[4], globalDeclarations, stringLiterals }),
        ];
        case 'equality': return [
            ...astToC({ ast: ast.children[0], globalDeclarations, stringLiterals }),
            '==',
            ...astToC({ ast: ast.children[2], globalDeclarations, stringLiterals }),
        ];
        case 'stringEquality': return [
            // TODO: Just compares pointers right now. Fix that.
            ...astToC({ ast: ast.children[0], globalDeclarations, stringLiterals }),
            '==',
            ...astToC({ ast: ast.children[2], globalDeclarations, stringLiterals }),
        ];
        case 'booleanLiteral': return [ast.value == 'true' ? '1' : '0'];
        case 'stringLiteral': return [ast.value];
        default:
            debugger;
            throw 'debugger';
    };
};

const stringLiteralDeclaration = stringLiteral => `char *${stringLiteral} = "${stringLiteral}";`;

export default ({
    functions,
    variables,
    program,
    globalDeclarations,
    stringLiterals,
}: BackendInputs) => {
    let Cfunctions = functions.map(({ name, argument, statements }) => {
        const prefix = `unsigned char ${name}(unsigned char ${argument.children[0].value}) {`;
        const suffix = `}`;

        const body = statements.map(statement => {
            return astToC({
                ast: statement,
                globalDeclarations,
                stringLiterals,
            }).join(' ');
        });

        return [
            prefix,
            ...body,
            suffix,
        ].join(' ');
    });
    let C = flatten(program.statements.map(child => astToC({ ast: child, globalDeclarations, stringLiterals })));
    let Cdeclarations = globalDeclarations
        .map(declaration => mplTypeToCDeclaration(declaration.type, declaration.name))
        .map(cDeclaration => `${cDeclaration};`);

    return `
#include <stdio.h>
#include <stdint.h>

int length(char *str) {
    int len = 0;
    while (*str != 0) {
        len++;
        str++;
    }
    return len;
}


${Cdeclarations.join('\n')}
${Cfunctions.join('\n')}
${stringLiterals.map(stringLiteralDeclaration).join('\n')}

int main(int argc, char **argv) {
    ${C.join('\n')}
}
`;
};
