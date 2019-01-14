import * as Ast from '../ast.js';
import { stat } from 'fs-extra';
import { file as tmpFile } from 'tmp-promise';
import {
    VariableDeclaration,
    FrontendOutput,
    Function,
    ExecutionResult,
    StringLiteralData,
    Backend,
    CompilationResult,
} from '../api.js';
import { Type, equal as typesAreEqual, builtinTypes } from '../types.js';
import flatten from '../util/list/flatten.js';
import last from '../util/list/last.js';
import { exec } from 'child-process-promise';
import execAndGetResult from '../util/execAndGetResult.js';
import debug from '../util/debug.js';
import join from '../util/join.js';
import { CompiledProgram, CompiledExpression, compileExpression, CompiledAssignment } from '../backend-utils.js';
import { errors } from '../runtime-strings.js';
import { mergeDeclarations } from '../frontend.js';
import idAppender from '../util/idAppender.js';
import writeTempFile from '../util/writeTempFile.js';
import { FileResult } from 'fs-extra';

// Beginnings of experiment with tracing code from source to target
const callFree = (target: string, reason: string) => `my_free(${target}); // ${reason}`;

// TODO: This returns a function, which is pretty janky. It looks like this because of the way function
// pointer declarations work in C: the variable name appears in the middle of the declaration
const mplTypeToCType = (type: Type): ((name: string) => string) => {
    switch (type.kind) {
        case 'Integer':
            return name => `uint8_t ${name}`;
        case 'Boolean':
            return name => `bool ${name}`;
        case 'String':
            return name => `char *${name}`;
        case 'Function':
            const returnType = mplTypeToCType(type.returnType)('');
            const argumentTypes = type.arguments.map(mplTypeToCType).map(f => f(''));
            const argumentsString = join(argumentTypes, ', ');
            return name => `${returnType} (*${name})(${argumentsString})`;
        case 'Product':
            return name => `struct ${type.name} ${name}`;
        default:
            throw debug(`${type.kind} unhandled in mplTypeToCType`);
    }
};

const mplTypeToCDeclaration = (type: Type, name: string): string => mplTypeToCType(type)(name);

type BackendInput = {
    ast: Ast.Ast;
    declarations: VariableDeclaration[];
    stringLiterals: StringLiteralData[];
    makeTemporary: (string) => string;
    predeclaredVariables: string[];
};

const compileAssignment = (destination: string, rhs: CompiledExpression<string>): CompiledAssignment<string> => {
    return {
        prepare: rhs.prepare,
        execute: [`${destination} = `, ...rhs.execute, ';'],
        cleanup: rhs.cleanup,
    };
};

const registerTransferLangaugeToC = (rtlCode: string[], joiner: string): string => {
    rtlCode.forEach(line => {
        if (typeof line !== 'string') debug('todo');
    });
    return join(rtlCode as string[], joiner);
};

const astToC = (input: BackendInput): CompiledProgram<string> => {
    const { ast, stringLiterals, declarations, makeTemporary, predeclaredVariables } = input;
    const recurse = newAst => astToC({ ...input, ast: newAst });
    const binaryOperator = (operator: string) => {
        const lhs = recurse((ast as any).lhs);
        const rhs = recurse((ast as any).rhs);
        return compileExpression([lhs, rhs], ([e1, e2]) => [...e1, operator, ...e2]);
    };
    if (!ast) debug('todo');
    switch (ast.kind) {
        case 'returnStatement': {
            const subExpression = recurse(ast.expression);
            return compileExpression([subExpression], ([e1]) => ['return', ...e1, ';']);
        }
        case 'number':
            return compileExpression([], ([]) => [ast.value.toString()]);
        case 'objectLiteral':
            const memberExpressions = ast.members.map(m => recurse(m.expression));
            const type = ast.type;
            if (type.kind != 'Product') {
                throw debug('need a produduct');
            }
            return compileExpression(memberExpressions, expr => [
                '(struct ',
                type.name,
                ')',
                '{',
                ...expr.map((e, i) => `.${ast.members[i].name} = ${e},`),
                '}',
            ]);
        case 'memberAccess': {
            const lhs = recurse(ast.lhs);
            return compileExpression([lhs], ([e1]) => ['(', ...e1, ').', ast.rhs]);
        }
        case 'product':
            return binaryOperator('*');
        case 'addition':
            return binaryOperator('+');
        case 'subtraction':
            return binaryOperator('-');
        case 'concatenation': {
            const lhs = recurse(ast.lhs);
            const rhs = recurse(ast.rhs);
            const temporaryName = makeTemporary('temporary_string');
            const lhsName = makeTemporary('concat_lhs');
            const rhsName = makeTemporary('concat_rhs');
            const prepAndCleanup = {
                prepare: [
                    `char *${lhsName} = ${registerTransferLangaugeToC(lhs.execute, ' ')};`,
                    `char *${rhsName} = ${registerTransferLangaugeToC(rhs.execute, ' ')};`,
                    `char *${temporaryName} = my_malloc(length(${lhsName}) + length(${rhsName}) + 1);`,
                    `string_concatenate(${lhsName}, ${rhsName}, ${temporaryName});`,
                ],
                execute: [],
                cleanup: [callFree(temporaryName, 'Free temporary from concatenation')],
            };
            return compileExpression([lhs, rhs, prepAndCleanup], ([_1, _2, _3]) => [temporaryName]);
        }
        // TODO: Unify these somehow typedDeclarationAssignment and reassignment
        case 'typedDeclarationAssignment': {
            const lhs = ast.destination;
            const rhs = recurse(ast.expression);
            const declaration = declarations.find(d => d.name === lhs);
            if (!declaration) throw debug('todo');
            switch (declaration.type.kind) {
                case 'Function':
                case 'Integer':
                case 'Product':
                    if (predeclaredVariables.includes(declaration.name)) {
                        return compileAssignment(declaration.name, rhs);
                    } else {
                        return compileAssignment(mplTypeToCDeclaration(declaration.type, lhs), rhs);
                    }
                case 'String':
                    const rhsWillAlloc = compileExpression([rhs], ([e1]) => [
                        'string_copy(',
                        ...e1,
                        ', my_malloc(length(',
                        ...e1,
                        ') + 1))',
                    ]);
                    if (predeclaredVariables.includes(declaration.name)) {
                        return compileAssignment(declaration.name, rhsWillAlloc);
                    } else {
                        return compileAssignment(mplTypeToCDeclaration(declaration.type, lhs), rhsWillAlloc);
                    }
                default:
                    throw debug(`${declaration.type.kind} unhandled in typedDeclarationAssignment`);
            }
        }
        case 'reassignment': {
            const lhs = ast.destination;
            const rhs = recurse(ast.expression);
            const declaration = declarations.find(d => d.name === lhs);
            if (!declaration) throw debug('todo');
            switch (declaration.type.kind) {
                case 'Function':
                case 'Integer':
                    return compileAssignment(lhs, rhs);
                case 'String':
                    // Free old value, copy new value.
                    const savedOldValue = makeTemporary('saved_old');
                    const temporaryName = makeTemporary('reassign_temporary');
                    const assign = {
                        prepare: [
                            `char *${savedOldValue} = ${declaration.name};`,
                            `char *${temporaryName} = ${registerTransferLangaugeToC(rhs.execute, ' ')};`,
                        ],
                        execute: [`my_malloc(length(${temporaryName}))`],
                        cleanup: [
                            `string_copy(${temporaryName}, ${declaration.name});`,
                            callFree(savedOldValue, 'free inaccessible value after reassignment'),
                        ],
                    };
                    const expression = compileExpression(
                        [rhs, assign],
                        // Can ignore rhs because it is executed during assign.
                        ([executeRhs, executeAssign]) => executeAssign
                    );
                    return compileAssignment(declaration.name, expression);
                default:
                    throw debug(`${declaration.type.kind} unhandled C reassignment`);
            }
        }
        case 'functionLiteral':
            return compileExpression([], ([]) => [`&${ast.deanonymizedName}`]);
        case 'callExpression': {
            const argumentsC = ast.arguments.map(argument => recurse(argument));
            return compileExpression(argumentsC, argCode => [
                `(*${ast.name})(`,
                join(argCode.map(code => registerTransferLangaugeToC(code, ' ')), ', '),
                ')',
            ]);
        }
        case 'identifier':
            return compileExpression([], ([]) => [ast.value]);
        case 'ternary': {
            const comparatorC = recurse(ast.condition);
            const ifTrueC = recurse(ast.ifTrue);
            const ifFalseC = recurse(ast.ifFalse);
            return compileExpression([comparatorC, ifTrueC, ifFalseC], ([compare, ifTrue, ifFalse]) => [
                ...compare,
                '?',
                ...ifTrue,
                ':',
                ...ifFalse,
            ]);
        }
        case 'equality': {
            const lhs = recurse(ast.lhs);
            const rhs = recurse(ast.rhs);
            if (ast.type.kind == 'String') {
                return compileExpression([lhs, rhs], ([e1, e2]) => ['string_compare(', ...e1, ',', ...e2, ')']);
            } else {
                return compileExpression([lhs, rhs], ([e1, e2]) => [...e1, '==', ...e2]);
            }
        }
        case 'booleanLiteral':
            return compileExpression([], ([]) => [ast.value ? '1' : '0']);
        case 'stringLiteral':
            const stringLiteralData = stringLiterals.find(({ value }) => value == ast.value);
            if (!stringLiteralData) throw debug('todo');
            return compileExpression([], ([]) => [stringLiteralName(stringLiteralData)]);
        case 'typeDeclaration':
            return compileExpression([], ([]) => []);
        default:
            throw debug(`${(ast as any).kind} unhandled in astToC`);
    }
    return debug('todo');
};

const stringLiteralName = ({ id, value }: StringLiteralData) =>
    `string_literal_${id}_${value.replace(/[^a-zA-Z]/g, '')}`;
const stringLiteralDeclaration = (literal: StringLiteralData) =>
    `char *${stringLiteralName(literal)} = "${literal.value}";`;

type SignatureBuilder = (name: String, parameters: VariableDeclaration[]) => string;

type MakeCFunctionBodyInputs = {
    name: any;
    parameters: VariableDeclaration[];
    statements: Ast.Statement[];
    variables: VariableDeclaration[];
    globalDeclarations: VariableDeclaration[];
    stringLiterals: StringLiteralData[];
    buildSignature: SignatureBuilder;
    returnType: Type;
    beforeExit?: string[];
};

const makeCfunctionBody = ({
    name,
    parameters,
    statements,
    variables,
    globalDeclarations,
    stringLiterals,
    buildSignature,
    returnType,
    beforeExit = [],
}: MakeCFunctionBodyInputs) => {
    const nonReturnStatements = statements.slice(0, statements.length - 1);
    const returnStatement = statements[statements.length - 1];
    if (returnStatement.kind !== 'returnStatement') throw debug('todo');
    const makeTemporary = idAppender();
    const globalVariableNames = globalDeclarations.map(d => d.name);
    const body = nonReturnStatements.map(statement => {
        const statementLogic = astToC({
            ast: statement,
            stringLiterals,
            declarations: mergeDeclarations(variables, globalDeclarations),
            makeTemporary,
            predeclaredVariables: globalVariableNames,
        });
        return join(
            [
                registerTransferLangaugeToC(statementLogic.prepare, '\n'),
                registerTransferLangaugeToC(statementLogic.execute, ' '),
                registerTransferLangaugeToC(statementLogic.cleanup, '\n'),
            ],
            '\n'
        );
    });
    const endOfFunctionFrees = variables
        .filter(s => !globalVariableNames.includes(s.name))
        .filter(s => !parameters.map(d => d.name).includes(s.name))
        .filter(s =>
            typesAreEqual(
                s.type,
                builtinTypes.String,
                [] /* TODO: maybe get actual type list in here? no need for comparing with string */
            )
        )
        .map(s => callFree(s.name, 'Freeing Stack String at end of function'));
    const returnCode = astToC({
        ast: returnStatement.expression,
        stringLiterals,
        declarations: mergeDeclarations(variables, globalDeclarations),
        makeTemporary,
        predeclaredVariables: globalVariableNames,
    });
    return join(
        [
            buildSignature(name, parameters),
            '{',
            ...body,
            ...returnCode.prepare,
            `${mplTypeToCDeclaration(returnType, 'result')} = ${registerTransferLangaugeToC(returnCode.execute, ' ')};`,
            ...returnCode.cleanup,
            ...endOfFunctionFrees,
            ...beforeExit,
            `return result;`,
            '}',
        ],
        '\n'
    );
};

const productTypeMemberToCStructMember = ({ name, type }) => `${mplTypeToCDeclaration(type, '')} ${name};`;

const compile = async ({
    functions,
    program,
    types,
    globalDeclarations,
    stringLiterals,
}: FrontendOutput): Promise<CompilationResult | { error: string }> => {
    const CtypeDeclarations = types
        .filter(t => t.type.kind == 'Product')
        .map(t => `struct ${t.name} {${join((t.type as any).members.map(productTypeMemberToCStructMember), '\n')}};`);

    const Cfunctions = functions.map(({ name, parameters, statements, variables, returnType }) =>
        makeCfunctionBody({
            name,
            parameters,
            statements,
            variables,
            globalDeclarations,
            stringLiterals,
            buildSignature: (functionName, params) => {
                const parameterDeclarations = params.map(p => mplTypeToCDeclaration(p.type, p.name));
                const cReturnType = mplTypeToCType(returnType)('');
                return `${cReturnType} ${functionName}(${join(parameterDeclarations, ', ')})`;
            },
            returnType,
        })
    );
    const Cprogram = makeCfunctionBody({
        name: 'main', // Unused for now
        parameters: [], // Unused for now
        statements: program.statements,
        variables: program.variables,
        globalDeclarations,
        stringLiterals,
        buildSignature: (_1, _2) => 'int main(int argc, char **argv)',
        returnType: { kind: 'Integer' }, // Main can only ever return integer
        beforeExit: [
            ...globalDeclarations
                .filter(d => d.type.kind == 'String')
                .map(d => `my_free(${d.name}); // Free global string`),
            'verify_no_leaks();',
        ],
    });
    const Cdeclarations = globalDeclarations
        .map(declaration => mplTypeToCDeclaration(declaration.type, declaration.name))
        .map(cDeclaration => `${cDeclaration};`);

    const cSource = `
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdbool.h>
#include <unistd.h>

struct block_info {
    size_t size;
    struct block_info *next_block; // NULL means no next block.
    bool free;
};

struct block_info *first_block = NULL; // Set to null because in the beginning, there are no blocks

bool done_searching_for_block(struct block_info *block, size_t requested_size) {
    if (block == NULL) {
        return true;
    }
    if (block->free && block->size >= requested_size) {
        return true;
    }
    return false;
}

void *my_malloc(size_t requested_size) {
    // Error out if we request zero bytes, that should never happen
    if (requested_size == 0) {
        printf("${errors.allocatedZero.value}");
        exit(-1);
    }

    struct block_info *current_block = first_block;
    struct block_info *previous_block = NULL;

    // Find the first free block that is large enough
    while (!done_searching_for_block(current_block, requested_size)) {
        previous_block = current_block;
        current_block = current_block->next_block;
    }

    if (current_block == NULL) {
        // No large enough blocks. Use sbrk to create a new one TODO: Switch to mmap on mac, sbrk is deprecated
        #pragma clang diagnostic ignored "-Wdeprecated-declarations"
        struct block_info *newly_allocated = (struct block_info*)sbrk(requested_size + sizeof(struct block_info));
        if (newly_allocated == (void*)-1) {
            printf("${errors.allocationFailed.value}");
            exit(-1); // TODO: Come up with an alloc failure strategy
        }

        if (first_block == NULL) {
            // First alloc!
            first_block = newly_allocated;
        } else if (previous_block != NULL) {
            previous_block->next_block = newly_allocated;
        }
        newly_allocated->size = requested_size;
        newly_allocated->next_block = NULL;
        newly_allocated->free = false;
        // Return pointer to the space after the block info (+1 actually adds sizeof(struct block_info))
        return newly_allocated + 1;
    } else {
        // Found an existing block, mark it as not free (TODO: Split it)
        current_block->free = false;
        // Return pointer to the space after the block info (+1 actually adds sizeof(struct block_info))
        return current_block + 1;
    }
}

void my_free(void *pointer) {
    if (pointer == NULL) {
        printf("${errors.freeNull.value}");
        exit(-1);
    }
    // TODO: Merge blocks
    // Get a pointer to the space after the block info (-1 actually subtracts sizeof(struct block_info))
    struct block_info *block_to_free = ((struct block_info *)pointer) - 1;
    if (block_to_free->free) {
        printf("${errors.doubleFree.value}");
        exit(-1);
    }
    block_to_free->free = true;
}

// Run through blocks and make sure they are free. For debugging.
void verify_no_leaks() {
    struct block_info *current_block = first_block;
    while (current_block != NULL) {
        if (!current_block->free) {
            printf("${errors.leaksDetected.value}");
            exit(-1);
        }
        current_block = current_block->next_block;
    }
}

int length(char *str) {
    int len = 0;
    while (*str++ && ++len) {}
    return len;
}

int print(char *str) {
    int result = printf("%s", str);
    if (result < 0) {
        printf("${errors.printFailed.value}");
        exit(-1);
    }
    return result;
}

char *string_copy(char *in, char *out) {
    char *original_out = out;
    while ((*out++ = *in++)) {}
    return original_out;
}

bool string_compare(char *in, char *out) {
    while (*in == *out) {
        if (*in == 0) {
            return true;
        }
        in++;
        out++;
    }
    return false;
}

char *string_concatenate(char *left, char *right, char *out) {
    char *original_out = out;
    char next;
    while ((next = *left)) {
        *out = next;
        out++;
        left++;
    }
    while ((next = *right)) {
        *out = next;
        out++;
        right++;
    }
    *out = 0;
    return original_out;
}

${join(CtypeDeclarations, '\n')}
${join(stringLiterals.map(stringLiteralDeclaration), '\n')}
${join(Cdeclarations, '\n')}
${join(Cfunctions, '\n')}
${Cprogram}
`;

    const sourceFile = await writeTempFile(cSource, '.c');
    const binaryFile = await tmpFile();
    try {
        // TODO: Don't emit unused variables
        await exec(`clang -Wall -Werror -Wno-error=unused-variable ${sourceFile.path} -o ${binaryFile.path}`);
    } catch (e) {
        return { error: `Failed to compile generated C code:\n${e.stderr}`, intermediateFile: sourceFile };
    }
    return {
        sourceFile,
        binaryFile,
        threeAddressCodeFile: undefined,
        debugInstructions: 'No debug instructions for C yet. Try one of the online GDB things.',
    };
};

const execute = async (path: string): Promise<ExecutionResult> => {
    try {
        return execAndGetResult(path);
    } catch (e) {
        return { error: e };
    }
};

const cBackend: Backend = { name: 'c', compile, execute };
export default cBackend;
