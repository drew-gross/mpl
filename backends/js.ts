import { Program } from '../threeAddressCode/Program';
import writeTempFile from '../util/writeTempFile';
import execAndGetResult from '../util/execAndGetResult';
import { FrontendOutput, ExecutionResult, CompilationResult, Backend, Variable } from '../api';
import * as Ast from '../ast';
import debug from '../util/debug';
import join from '../util/join';

const needsAwait = (decl: Variable | undefined) => {
    if (!decl) return false;
    if ('namedType' in decl.type) throw debug('TODO get a real type here');
    if (decl.type.type.kind != 'Function') return false;
    if (decl.type.type.permissions.includes('stdout')) return true;
    return false;
};

const astToJS = ({
    ast,
    exitInsteadOfReturn,
    builtinFunctions,
}: {
    ast: Ast.Ast;
    exitInsteadOfReturn: boolean;
    builtinFunctions: Variable[];
}): string[] => {
    if (!ast) debugger;
    const recurse = newInput =>
        astToJS({ ast: newInput, exitInsteadOfReturn, builtinFunctions });
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
        case 'declaration':
            return [`let ${ast.destination} = `, ...recurse(ast.expression), ';'];
        case 'functionReference':
            return [ast.name];
        case 'callExpression':
            const functionName = ast.name;
            const functionDecl = builtinFunctions.find(({ name }) => name == functionName);
            const jsArguments: string[][] = ast.arguments.map(argument => recurse(argument));
            const awaitStr = needsAwait(functionDecl) ? 'await' : '';
            return [
                awaitStr + ` ${ast.name}(`,
                join(
                    jsArguments.map(argument => join(argument, ' ')),
                    ', '
                ),
                `)`,
            ];
        case 'identifier':
            return [ast.value];
        case 'ternary':
            return [
                ...recurse(ast.condition),
                '?',
                ...recurse(ast.ifTrue),
                ':',
                ...recurse(ast.ifFalse),
            ];
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
            const members = ast.members.map(
                ({ name, expression }) => `${name}: ${recurse(expression)}`
            );
            return ['{', join(members, ','), '}'];
        case 'memberAccess':
            return ['(', ...recurse(ast.lhs), ').', ast.rhs];
        case 'listLiteral':
            const items = ast.items.map(item => join(recurse(item), ', '));
            return ['[', join(items, ', '), ']'];
        case 'indexAccess':
            return ['(', ...recurse(ast.accessed), ')[(', ...recurse(ast.index), ')]'];
        case 'forLoop':
            const body: string[] = ast.body.map(recurse).flat();
            const listItems: string[] = recurse(ast.list);
            return [
                `const items = `,
                ...listItems,
                `;`,
                `for (let i = 0; i < items.length; i++) {`,
                `const ${ast.var} = items[i];`,
                ...body,
                `}`,
            ];
        default:
            throw debug(`${(ast as any).kind} unhanlded in toJS`);
    }
};

const compile = ({
    functions,
    builtinFunctions,
    program,
}: FrontendOutput): { target: string; tac: Program | undefined } | { error: string } => {
    const JSfunctions: string[] = [];
    functions.forEach(({ parameters, statements }, name) => {
        const prefix = `const ${name} = (${join(
            parameters.map(parameter => parameter.name),
            ', '
        )}) => {`;
        const suffix = `}`;

        const body = statements.map(statement => {
            return join(
                astToJS({ ast: statement, exitInsteadOfReturn: false, builtinFunctions }),
                ' '
            );
        });

        JSfunctions.push([prefix, ...body, suffix].join(' '));
    });

    if (Array.isArray(program)) {
        // Must be a module
        const exp = program.map(v => {
            return `export const ${v.exportedName} = ${v.declaredName};`;
        });
        return {
            target: `
                ${join(JSfunctions, '\n')}
                ${join(exp, '\n')}
            `,
            tac: undefined,
        };
    }
    const JS: string[] = program.statements
        .map(child => astToJS({ ast: child, builtinFunctions, exitInsteadOfReturn: true }))
        .flat();
    return {
        target: `
const readline = require('readline');

const length = str => str.length;
const startsWith = (haystack, needle) => haystack.startsWith(needle);
const print = str => process.stdout.write(str);

const readInt = async () => {
    return new Promise((resolve, reject) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        rl.on('line', line => {
            rl.close();
            resolve(line);
        });
    });
};

(async () => {
    ${join(JSfunctions, '\n')}
    ${join(JS, '\n')}
})();`,
        tac: undefined,
    };
};

const finishCompilation = async (
    jsSource: string,
    tac: Program | undefined
): Promise<CompilationResult | { error: string }> => {
    if (tac !== undefined) {
        debug('why tac');
    }

    const sourceFile = await writeTempFile(jsSource, 'program', 'js');
    const binaryFile = sourceFile;
    return {
        source: jsSource,
        sourceFile,
        binaryFile,
        threeAddressCodeFile: undefined,
    };
};

const execute = async (executablePath: string, stdinPath: string): Promise<ExecutionResult> => {
    try {
        const runInstructions = `node ${executablePath} < ${stdinPath}`;
        return {
            ...(await execAndGetResult(runInstructions)),
            executorName: 'node',
            runInstructions,
            debugInstructions: `./node_modules/.bin/node --inspect --inspect-brk ${executablePath}`,
        };
    } catch (e) {
        return { error: e.msg, executorName: 'node' };
    }
};

const jsBackend: Backend = {
    name: 'js',
    compile,
    finishCompilation,
    executors: [{ execute, name: 'node' }],
};
export default jsBackend;
