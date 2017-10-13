import flatten from '../util/list/flatten.js';

const astToJS = ({ ast, exitInsteadOfReturn }) => {
    if (!ast) debugger;
    switch (ast.type) {
        case 'returnStatement': {
            if (exitInsteadOfReturn) {
                return [`process.exit(${astToJS({
                    ast: ast.children[1],
                    exitInsteadOfReturn,
                }).join(' ')})`];
            } else {
                return [
                    `return `,
                    ...astToJS({
                        ast: ast.children[1],
                        exitInsteadOfReturn,
                    }),
                ];
            }
        };
        case 'number': return [ast.value.toString()];
        case 'product': return [
            ...astToJS({
                ast: ast.children[0],
                exitInsteadOfReturn,
            }),
            '*',
            ...astToJS({
                ast: ast.children[1],
                exitInsteadOfReturn
            }),
        ];
        case 'subtraction': return [
            ...astToJS({
                ast: ast.children[0],
                exitInsteadOfReturn,
            }),
            '-',
            ...astToJS({
                ast: ast.children[1],
                exitInsteadOfReturn
            }),
        ];
        case 'statement': return flatten(ast.children.map(child => astToJS({
            ast: child,
            exitInsteadOfReturn,
        })));
        case 'statementSeparator': return [];
        case 'typedAssignment': return [
            `const ${ast.children[0].value} = `,
            ...astToJS({
                ast: ast.children[4],
                exitInsteadOfReturn,
            }),
            ';',
        ];
        case 'assignment': return [
            `const ${ast.children[0].value} = `,
            ...astToJS({
                ast: ast.children[2],
                exitInsteadOfReturn
            }),
            ';',
        ];
        case 'functionLiteral': return [ast.value];
        case 'callExpression': return [
            `${ast.children[0].value}(`,
            ...astToJS({
                ast: ast.children[2],
                exitInsteadOfReturn,
            }),
            `)`];
        case 'identifier': return [ast.value];
        case 'ternary': return [
            ...astToJS({
                ast: ast.children[0],
                exitInsteadOfReturn,
            }),
            '?',
            ...astToJS({
                ast: ast.children[2],
                exitInsteadOfReturn,
            }),
            ':',
            ...astToJS({
                ast: ast.children[4],
                exitInsteadOfReturn,
            }),
        ];
        case 'equality': return [
            ...astToJS({
                ast: ast.children[0],
                exitInsteadOfReturn,
            }),
            '==',
            ...astToJS({
                ast: ast.children[2],
                exitInsteadOfReturn,
            }),
        ];
        case 'booleanLiteral': return [ast.value];
        case 'stringLiteral': return [`"${ast.value}"`];
        default:
            debugger;
            return;
    }
};

export default (functions, variables, program, globalDeclarations) => {
    let JSfunctions = functions.map(({ name, argument, statements }) => {
        const prefix = `${name} = ${argument.children[0].value} => {`;
        const suffix = `}`;

        const body = statements.map(statement => {
            return astToJS({
                ast: statement,
                exitInsteadOfReturn: false,
            }).join(' ');
        });

        return [
            prefix,
            ...body,
            suffix,
        ].join(' ');
    });

    let JS = flatten(program.statements.map(child => astToJS({
        ast: child,
        exitInsteadOfReturn: true,
    })));
    return `
const length = str => str.length;
${JSfunctions.join('\n')}
${JS.join('\n')}`;
};
