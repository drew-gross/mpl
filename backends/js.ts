import flatten from '../util/list/flatten.js';
import execAndGetResult from '../util/execAndGetResult.js';
import { BackendInputs, ExecutionResult } from '../api.js';
import * as Ast from '../ast.js';
import debug from '../util/debug.js';

const astToJS = ({ ast, exitInsteadOfReturn }: { ast: Ast.LoweredAst, exitInsteadOfReturn: boolean }) => {
    if (!ast) debugger;
    switch (ast.kind) {
        case 'returnStatement': {
            if (exitInsteadOfReturn) {
                return [`process.exit(${astToJS({
                    ast: ast.expression,
                    exitInsteadOfReturn,
                }).join(' ')})`];
            } else {
                return [
                    `return `,
                    ...astToJS({
                        ast: ast.expression,
                        exitInsteadOfReturn,
                    }),
                ];
            }
        };
        case 'number': return [ast.value.toString()];
        case 'product': return [
            ...astToJS({
                ast: ast.lhs,
                exitInsteadOfReturn,
            }),
            '*',
            ...astToJS({
                ast: ast.rhs,
                exitInsteadOfReturn
            }),
        ];
        case 'subtraction': return [
            ...astToJS({
                ast: ast.lhs,
                exitInsteadOfReturn,
            }),
            '-',
            ...astToJS({
                ast: ast.rhs,
                exitInsteadOfReturn
            }),
        ];
        case 'statement': return flatten(ast.children.map(child => astToJS({
            ast: child,
            exitInsteadOfReturn,
        })));
        case 'typedAssignment': return [
            `const ${ast.destination} = `,
            ...astToJS({
                ast: ast.expression,
                exitInsteadOfReturn,
            }),
            ';',
        ];
        case 'functionLiteral': return [ast.deanonymizedName];
        case 'callExpression': return [
            `${ast.name}(`,
            ...astToJS({
                ast: ast.argument,
                exitInsteadOfReturn,
            }),
            `)`];
        case 'identifier': return [ast.value];
        case 'ternary': return [
            ...astToJS({
                ast: ast.condition,
                exitInsteadOfReturn,
            }),
            '?',
            ...astToJS({
                ast: ast.ifTrue,
                exitInsteadOfReturn,
            }),
            ':',
            ...astToJS({
                ast: ast.ifFalse,
                exitInsteadOfReturn,
            }),
        ];
        case 'equality': return [
            ...astToJS({
                ast: ast.lhs,
                exitInsteadOfReturn,
            }),
            '==',
            ...astToJS({
                ast: ast.rhs,
                exitInsteadOfReturn,
            }),
        ];
        case 'stringEquality':  return [
            ...astToJS({
                ast: ast.lhs,
                exitInsteadOfReturn,
            }),
            '==',
            ...astToJS({
                ast: ast.rhs,
                exitInsteadOfReturn,
            }),
        ];
        case 'booleanLiteral': return [ast.value];
        case 'stringLiteral': return [`"${ast.value}"`];
        case 'concatenation': return [
            '(',
            ...astToJS({
                ast: ast.lhs,
                exitInsteadOfReturn,
            }),
            ').concat(',
            ...astToJS({
                ast: ast.rhs,
                exitInsteadOfReturn,
            }),
            ')',
        ];
        default:
            debugger;
            throw "debugger";
    }
};

const toExectuable = ({functions, program, globalDeclarations, stringLiterals}: BackendInputs) => {
    let JSfunctions = functions.map(({ name, argument, statements }) => {
        const prefix = `${name} = ${argument.name} => {`;
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

const execute = async (path: string): Promise<ExecutionResult> => {
    try {
        return execAndGetResult(`node ${path}`);
    } catch (e) {
        return { error: e.msg };
    }
};

export default {
    toExectuable,
    execute,
    name: 'js',
};
