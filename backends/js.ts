import { exec } from 'child-process-promise';
import { stat } from 'fs-extra';
import flatten from '../util/list/flatten.js';
import execAndGetResult from '../util/execAndGetResult.js';
import { FrontendOutput, ExecutionResult } from '../api.js';
import * as Ast from '../ast.js';
import debug from '../util/debug.js';
import join from '../util/join.js';

const astToJS = ({ ast, exitInsteadOfReturn }: { ast: Ast.Ast; exitInsteadOfReturn: boolean }): string[] => {
    if (!ast) debugger;
    const recurse = newInput => astToJS({ ast: newInput, exitInsteadOfReturn });
    switch (ast.kind) {
        case 'returnStatement': {
            if (exitInsteadOfReturn) {
                return [`process.exit(${recurse(ast.expression).join(' ')})`];
            } else {
                return [`return `, ...recurse(ast.expression)];
            }
        }
        case 'number':
            return [ast.value.toString()];
        case 'product':
            return [...recurse(ast.lhs), '*', ...recurse(ast.rhs)];
        case 'subtraction':
            return [...recurse(ast.lhs), '-', ...recurse(ast.rhs)];
        case 'addition':
            return [...recurse(ast.lhs), '+', ...recurse(ast.rhs)];
        case 'reassignment':
            return [ast.destination, '=', ...recurse(ast.expression), ';'];
        case 'typedDeclarationAssignment':
            return [`let ${ast.destination} = `, ...recurse(ast.expression), ';'];
        case 'functionLiteral':
            return [ast.deanonymizedName];
        case 'callExpression':
            const jsArguments: string[][] = ast.arguments.map(argument => recurse(argument));
            return [`${ast.name}(`, join(jsArguments.map(argument => join(argument, ' ')), ', '), `)`];
        case 'identifier':
            return [ast.value];
        case 'ternary':
            return [...recurse(ast.condition), '?', ...recurse(ast.ifTrue), ':', ...recurse(ast.ifFalse)];
        case 'equality':
            return [...recurse(ast.lhs), '==', ...recurse(ast.rhs)];
        case 'booleanLiteral':
            return [ast.value ? 'true' : 'false'];
        case 'stringLiteral':
            return [`"${ast.value}"`];
        case 'concatenation':
            return ['(', ...recurse(ast.lhs), ').concat(', ...recurse(ast.rhs), ')'];
        case 'typeDeclaration':
            return [''];
        case 'objectLiteral':
            const members = ast.members.map(({ name, expression }) => `${name}: ${recurse(expression)}`);
            return ['{', join(members, ','), '}'];
        case 'memberAccess':
            return ['(', ...recurse(ast.lhs), ').', ast.rhs];
        default:
            throw debug(`${(ast as any).kind} unhanlded in toJS`);
    }
};

const mplToExectuable = ({ functions, program, globalDeclarations }: FrontendOutput) => {
    const JSfunctions = functions.map(({ name, parameters, statements }) => {
        const prefix = `${name} = (${join(parameters.map(parameter => parameter.name), ', ')}) => {`;
        const suffix = `}`;

        const body = statements.map(statement => {
            return join(astToJS({ ast: statement, exitInsteadOfReturn: false }), ' ');
        });

        return [prefix, ...body, suffix].join(' ');
    });

    const JS: string[] = flatten(
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
    mplToExectuable,
    execute,
    name: 'js',
    debug: path => exec(`${__dirname}/../../node_modules/.bin/inspect ${path}`),
    binSize: async path => (await stat(path)).size,
};
