import flatten from '../util/list/flatten.js';
import { typeOfExpression, VariableDeclaration, Type, BackendInputs, Function } from '../compiler.js';

const mplTypeToCDeclaration = (type: Type, name: string) => {
    if (!type) debugger;
    switch (type.name) {
        case 'Function': return `unsigned char (*${name})(unsigned char)`
        case 'Integer': return `uint8_t ${name}`;
        case 'String': return `char *${name}`;
        default:
            debugger;
            throw 'debugger';
    }
};

type BackendInput = {
    ast: any,
    globalDeclarations: VariableDeclaration[],
    localDeclarations: VariableDeclaration[],
    stringLiterals: string[],
};

const astToC = ({
    ast,
    globalDeclarations,
    stringLiterals,
    localDeclarations,
}: BackendInput): string[] => {
    if (!ast) debugger;
    switch (ast.type) {
        case 'returnStatement': return [
            `return`,
            ...astToC({ ast: ast.children[1], globalDeclarations, stringLiterals, localDeclarations }),
            ';',
        ];
        case 'number': return [ast.value.toString()];
        case 'product': {
            return [
                ...astToC({ ast: ast.children[0], globalDeclarations, stringLiterals, localDeclarations }),
                '*',
                ...astToC({ ast: ast.children[1], globalDeclarations, stringLiterals, localDeclarations }),
            ];
        }
        case 'subtraction': return [
            ...astToC({ ast: ast.children[0], globalDeclarations, stringLiterals, localDeclarations }),
            '-',
            ...astToC({ ast: ast.children[1], globalDeclarations, stringLiterals, localDeclarations }),
        ];
        case 'statement': return flatten(ast.children.map(child => astToC({ ast: child, globalDeclarations, stringLiterals, localDeclarations })));
        case 'statementSeparator': return [];
        case 'typedAssignment':
        case 'assignment': {
            const rhsIndex = ast.type === 'assignment' ? 2 : 4;
            const lhs = ast.children[0].value;
            const rhs = astToC({ ast: ast.children[rhsIndex], globalDeclarations, stringLiterals, localDeclarations });
            if (globalDeclarations.some(declaration => declaration.name === lhs)) {
                const declaration = globalDeclarations.find(declaration => declaration.name === lhs);
                if (!declaration) {
                    debugger;
                    throw "fail";
                }
                switch (declaration.type.name) {
                    case 'Function':
                        return [`${lhs} = `, ...rhs, `;`];
                    case 'String': {
                        return [
                            `${lhs} = malloc(length(${rhs}));`,
                            `string_copy(${lhs}, ${rhs});`,
                        ];
                    }
                    default:
                        debugger;
                        throw 'debugger';
                }
            } else {
                const declaration = localDeclarations.find(declaration => declaration.name === lhs);
                if (!declaration) {
                    debugger;
                    throw "fail";
                }
                switch (declaration.type.name) {
                    case 'Function':
                    case 'Integer':
                        return [`${mplTypeToCDeclaration(declaration.type, lhs)} = `, ...rhs, `;`];
                    case 'String':
                        switch (declaration.memoryCategory) {
                            case 'Dynamic': return [
                                `${mplTypeToCDeclaration(declaration.type, lhs)} = malloc(length(${rhs}));`,
                                `string_copy(${rhs}, ${lhs});`,
                            ];
                            case 'GlobalStatic': return [
                                `${mplTypeToCDeclaration(declaration.type, lhs)} = `, ...rhs, `;`,
                            ]
                            default:
                                debugger;
                                throw 'debugger';
                        }
                    default:
                        debugger;
                        throw 'debugger';
                }
            }
        }
        case 'functionLiteral': return [`&${ast.value}`];
        case 'callExpression': return [
            `(*${ast.children[0].value})(`,
            ...astToC({ ast: ast.children[2], globalDeclarations, stringLiterals, localDeclarations }),
            `)`,
        ];
        case 'identifier': return [ast.value];
        case 'ternary': return [
            ...astToC({ ast: ast.children[0], globalDeclarations, stringLiterals, localDeclarations }),
            '?',
            ...astToC({ ast: ast.children[2], globalDeclarations, stringLiterals, localDeclarations }),
            ':',
            ...astToC({ ast: ast.children[4], globalDeclarations, stringLiterals, localDeclarations }),
        ];
        case 'equality': return [
            ...astToC({ ast: ast.children[0], globalDeclarations, stringLiterals, localDeclarations }),
            '==',
            ...astToC({ ast: ast.children[2], globalDeclarations, stringLiterals, localDeclarations }),
        ];
        case 'stringEquality': return [
            // TODO: Just compares pointers right now. Fix that.
            ...astToC({ ast: ast.children[0], globalDeclarations, stringLiterals, localDeclarations }),
            '==',
            ...astToC({ ast: ast.children[2], globalDeclarations, stringLiterals, localDeclarations }),
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
    program,
    globalDeclarations,
    stringLiterals,
}: BackendInputs) => {
    let Cfunctions = functions.map(({ name, argument, statements, variables }) => {
        const prefix = `unsigned char ${name}(unsigned char ${argument.children[0].value}) {`;
        const suffix = `}`;

        const body = statements.map(statement => {
            return astToC({
                ast: statement,
                globalDeclarations,
                stringLiterals,
                localDeclarations: variables,
            }).join(' ');
        });

        return [
            prefix,
            ...body,
            suffix,
        ].join(' ');
    });
    const nonReturnStatements = program.statements.slice(0, program.statements.length - 1);
    const returnStatement = program.statements[program.statements.length - 1];
    let Cprogram = flatten(nonReturnStatements.map(child => astToC({
        ast: child,
        globalDeclarations,
        stringLiterals,
        localDeclarations: program.variables,
    })));
    let CprogramFrees = program.variables
        .filter(s => s.memoryCategory === 'Dynamic')
        .map(s => `free(${s.name});`);
    let CcreateResult = astToC({
        ast: returnStatement.children[1],
        globalDeclarations,
        stringLiterals,
        localDeclarations: program.variables,
    });
    // Only Integers can be returned from main program
    let CassignResult = `${mplTypeToCDeclaration({ name: 'Integer' }, 'result')} = ${CcreateResult.join('\n')};`;
    let CreturnResult = `return result;`;

    let Cdeclarations = globalDeclarations
        .map(declaration => mplTypeToCDeclaration(declaration.type, declaration.name))
        .map(cDeclaration => `${cDeclaration};`);

    return `
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>

int length(char *str) {
    int len = 0;
    while (*str++ && ++len) {}
    return len;
}

void string_copy(char *in, char *out) {
    while ((*out++ = *in++)) {}
}

${Cdeclarations.join('\n')}
${Cfunctions.join('\n')}
${stringLiterals.map(stringLiteralDeclaration).join('\n')}

int main(int argc, char **argv) {
    ${Cprogram.join('\n')}
    ${CassignResult}
    ${CprogramFrees.join('\n')}
    ${CreturnResult}
}
`;
};
