import flatten from '../util/list/flatten.js';
import execAndGetResult from '../util/execAndGetResult.js';
import { BackendInputs, ExecutionResult } from '../api.js';
import * as Ast from '../ast.js';
import debug from '../util/debug.js';
import join from '../util/join.js';

const astToJS = ({ ast, exitInsteadOfReturn }: { ast: Ast.Ast; exitInsteadOfReturn: boolean }): string[] => {
    if (!ast) debugger;
    const recurse = newInput => astToJS({ ast, exitInsteadOfReturn, ...newInput });
    switch (ast.kind) {
        case 'returnStatement': {
            if (exitInsteadOfReturn) {
                return [`process.exit(${recurse({ ast: ast.expression }).join(' ')})`];
            } else {
                return [`return `, ...recurse({ ast: ast.expression })];
            }
        }
        case 'number':
            return [ast.value.toString()];
        case 'product':
            return [...recurse({ ast: ast.lhs }), '*', ...recurse({ ast: ast.rhs })];
        case 'subtraction':
            return [...recurse({ ast: ast.lhs }), '-', ...recurse({ ast: ast.rhs })];
        case 'addition':
            return [...recurse({ ast: ast.lhs }), '+', ...recurse({ ast: ast.rhs })];
        case 'typedAssignment':
            return [`const ${ast.destination} = `, ...recurse({ ast: ast.expression }), ';'];
        case 'functionLiteral':
            return [ast.deanonymizedName];
        case 'callExpression':
            const jsArguments: string[][] = ast.arguments.map(argument => recurse({ ast: argument }));
            return [`${ast.name}(`, join(jsArguments.map(argument => join(argument, ' ')), ', '), `)`];
        case 'identifier':
            return [ast.value];
        case 'ternary':
            return [
                ...recurse({ ast: ast.condition }),
                '?',
                ...recurse({ ast: ast.ifTrue }),
                ':',
                ...recurse({ ast: ast.ifFalse }),
            ];
        case 'equality':
            return [...recurse({ ast: ast.lhs }), '==', ...recurse({ ast: ast.rhs })];
        case 'booleanLiteral':
            return [ast.value ? 'true' : 'false'];
        case 'stringLiteral':
            return [`"${ast.value}"`];
        case 'concatenation':
            return ['(', ...recurse({ ast: ast.lhs }), ').concat(', ...recurse({ ast: ast.rhs }), ')'];
        default:
            throw debug();
    }
};

const toExectuable = ({ functions, program, globalDeclarations }: BackendInputs) => {
    let JSfunctions = functions.map(({ name, parameters, statements }) => {
        const prefix = `${name} = (${join(parameters.map(parameter => parameter.name), ', ')}) => {`;
        const suffix = `}`;

        const body = statements.map(statement => {
            return join(astToJS({ ast: statement, exitInsteadOfReturn: false }), ' ');
        });

        return [prefix, ...body, suffix].join(' ');
    });

    let JS: string[] = flatten(
        program.statements.map(child =>
            astToJS({
                ast: child,
                exitInsteadOfReturn: true,
            })
        )
    );
    return `
const length = str => str.length;
const print = str => process.stdout.write(str);
${join(JSfunctions, '\n')}
${join(JS, '\n')}`;
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
