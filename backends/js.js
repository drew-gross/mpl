import flatten from '../util/list/flatten.js';

const astToJS = ({ ast, destination, exitInsteadOfReturn }) => {
    if (!ast) debugger;
    switch (ast.type) {
        case 'returnStatement': {
            if (exitInsteadOfReturn) {
                return [`process.exit(${astToJS({
                    ast: ast.children[1],
                    destination,
                }).join(' ')})`];
            } else {
                return [
                    `return `,
                    ...astToJS({
                        ast: ast.children[1],
                        destination,
                    }),
                ];
            }
        };
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
        case 'typedAssignment': return [
            `const ${ast.children[0].value} = `,
            ...astToJS({
                ast: ast.children[4],
                destination,
            }),
            ';',
        ];
        case 'assignment': return [
            `const ${ast.children[0].value} = `,
            ...astToJS({
                ast: ast.children[2],
                destination
            }),
            ';',
        ];
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

module.exports = (functions, variables, program, globalDeclarations) => {
    let JSfunctions = functions.map(({ name, argument, statements }) => {
        const prefix = `${name} = ${argument.children[0].value} => {`;
        const suffix = `}`;

        const body = statements.map(statement => {
            return astToJS({
                ast: statement,
                globalDeclarations,
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
${JSfunctions.join('\n')}
${JS.join('\n')}`;
};
