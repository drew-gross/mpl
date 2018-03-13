import * as Ast from '../ast.js';
import { file as tmpFile } from 'tmp-promise';
import { VariableDeclaration, Type, BackendInputs, Function, ExecutionResult, StringLiteralData } from '../api.js';
import flatten from '../util/list/flatten.js';
import last from '../util/list/last.js';
import { exec } from 'child-process-promise';
import execAndGetResult from '../util/execAndGetResult.js';
import debug from '../util/debug.js';
import join from '../util/join.js';
import { CompiledProgram, CompiledExpression, compileExpression } from '../backend-utils.js';
import { errors } from '../runtime-strings.js';

// Beginnings of experiment with tracing code from source to target
const callFree = (target: string, reason: string) => `my_free(${target}); // ${reason}`;

const mplTypeToCType = (type: Type): ((name: string) => string) => {
    switch (type.name) {
        case 'Integer':
            return name => `uint8_t ${name}`;
        case 'Boolean':
            return name => `bool ${name}`;
        case 'String':
            return name => `char *${name}`;
        case 'Function':
            const returnType = mplTypeToCType(last(type.arguments) as Type)('');
            const argumentTypes = type.arguments
                .slice(0, type.arguments.length - 1)
                .map(mplTypeToCType)
                .map(f => f(''));
            const argumentsString = join(argumentTypes, ', ');
            return name => `${returnType} (*${name})(${argumentsString})`;
        default:
            throw debug();
    }
};

const mplTypeToCDeclaration = (type: Type, name: string): string => mplTypeToCType(type)(name);

type BackendInput = {
    ast: Ast.Ast;
    globalDeclarations: VariableDeclaration[];
    localDeclarations: VariableDeclaration[];
    stringLiterals: StringLiteralData[];
};

type CompiledAssignment = {
    prepare: string[];
    execute: string[];
    cleanup: string[];
};

const compileAssignment = (destination: string, rhs: CompiledExpression): CompiledAssignment => {
    return {
        prepare: rhs.prepare,
        execute: [`${destination} = `, ...rhs.execute, ';'],
        cleanup: rhs.cleanup,
    };
};

let currentTemporaryId = 0;
const getTemporaryId = () => {
    currentTemporaryId++;
    return currentTemporaryId;
};

const astToC = (input: BackendInput): CompiledProgram => {
    const { ast, globalDeclarations, stringLiterals, localDeclarations } = input;
    const recurse = newInput => astToC({ ...input, ...newInput });
    if (!ast) debug();
    switch (ast.kind) {
        case 'returnStatement': {
            const subExpression = recurse({ ast: ast.expression });
            return compileExpression([subExpression], ([e1]) => ['return', ...e1, ';']);
        }
        case 'number':
            return compileExpression([], ([]) => [ast.value.toString()]);
        case 'product': {
            const lhs = recurse({ ast: ast.lhs });
            const rhs = recurse({ ast: ast.rhs });
            return compileExpression([lhs, rhs], ([e1, e2]) => [...e1, '*', ...e2]);
        }
        case 'addition': {
            const lhs = recurse({ ast: ast.lhs });
            const rhs = recurse({ ast: ast.rhs });
            return compileExpression([lhs, rhs], ([e1, e2]) => [...e1, '+', ...e2]);
        }
        case 'subtraction': {
            const lhs = recurse({ ast: ast.lhs });
            const rhs = recurse({ ast: ast.rhs });
            return compileExpression([lhs, rhs], ([e1, e2]) => [...e1, '-', ...e2]);
        }
        case 'concatenation': {
            const lhs = recurse({ ast: ast.lhs });
            const rhs = recurse({ ast: ast.rhs });
            const temporaryName = `temporary_string_${getTemporaryId()}`;
            const lhsName = `concat_lhs_${getTemporaryId()}`;
            const rhsName = `concat_rhs_${getTemporaryId()}`;
            const prepAndCleanup = {
                prepare: [
                    `char *${lhsName} = ${join(lhs.execute, ' ')};`,
                    `char *${rhsName} = ${join(rhs.execute, ' ')};`,
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
            const rhs = recurse({ ast: ast.expression });
            if (globalDeclarations.some(declaration => declaration.name === lhs)) {
                const declaration = globalDeclarations.find(declaration => declaration.name === lhs);
                if (!declaration) throw debug();
                switch (declaration.type.name) {
                    case 'Function':
                    case 'Integer':
                        return compileAssignment(lhs, rhs);
                    case 'String': {
                        const rhsWillAlloc = compileExpression([rhs], ([e]) => [
                            `string_copy(${e}, my_malloc(length(${e}) + 1));`,
                        ]);
                        return compileAssignment(lhs, rhsWillAlloc);
                    }
                    default:
                        debug();
                }
            } else {
                const declaration = localDeclarations.find(declaration => declaration.name === lhs);
                if (!declaration) throw debug();
                switch (declaration.type.name) {
                    case 'Function':
                    case 'Integer':
                        return compileAssignment(mplTypeToCDeclaration(declaration.type, lhs), rhs);
                    case 'String':
                        switch (declaration.location) {
                            case 'Stack': {
                                const rhsWillAlloc = compileExpression([rhs], ([e1]) => [
                                    'string_copy(',
                                    ...e1,
                                    ', my_malloc(length(',
                                    ...e1,
                                    ') + 1))',
                                ]);
                                return compileAssignment(mplTypeToCDeclaration(declaration.type, lhs), rhsWillAlloc);
                            }
                            case 'Parameter':
                            case 'Global':
                                return compileAssignment(mplTypeToCDeclaration(declaration.type, lhs), rhs);
                            default:
                                throw debug();
                        }
                    default:
                        throw debug();
                }
            }
            throw debug();
        }
        case 'reassignment': {
            const lhs = ast.destination;
            const rhs = recurse({ ast: ast.expression });
            if (globalDeclarations.some(declaration => declaration.name === lhs)) {
                const declaration = globalDeclarations.find(declaration => declaration.name === lhs);
                if (!declaration) throw debug();
                switch (declaration.type.name) {
                    case 'Function':
                    case 'Integer':
                        return compileAssignment(lhs, rhs);
                    case 'String':
                        switch (declaration.location) {
                            case 'Stack':
                                // Free old value, copy new value.
                                const rhs = recurse({ ast: ast.expression });
                                const savedOldValue = `saved_old_${getTemporaryId()}`;
                                const temporaryName = `reassign_temporary_${getTemporaryId()}`;
                                const prepAndCleanup = {
                                    prepare: [
                                        `char *${savedOldValue} = ${declaration.name};`,
                                        `char *${temporaryName} = ${join(rhs.execute, ' ')};`,
                                        `char *${declaration.name} = my_malloc(length(${temporaryName}));`,
                                        `string_copy(${temporaryName}, ${declaration.name}),`,
                                    ],
                                    execute: [],
                                    cleanup: [callFree(savedOldValue, 'free inaccessible value after reassignment')],
                                };
                                return prepAndCleanup;
                            case 'Global':
                                throw debug();
                            case 'Parameter':
                                // Shouldn't be possible, can't reassign parameters
                                throw debug();
                            default:
                                throw debug();
                        }
                    default:
                        throw debug();
                }
            } else {
                const declaration = localDeclarations.find(declaration => declaration.name === lhs);
                if (!declaration) throw debug();
                switch (declaration.type.name) {
                    case 'Function':
                    case 'Integer':
                        return compileAssignment(lhs, rhs);
                    case 'String':
                        //TODO: need to de-alloc the thing we are overwriting.
                        throw debug();
                    default:
                        throw debug();
                }
            }
        }
        case 'functionLiteral':
            return compileExpression([], ([]) => [`&${ast.deanonymizedName}`]);
        case 'callExpression': {
            const argumentsC = ast.arguments.map(argument => recurse({ ast: argument }));
            return compileExpression(argumentsC, argCode => [
                `(*${ast.name})(`,
                join(argCode.map(code => join(code, ' ')), ', '),
                ')',
            ]);
        }
        case 'identifier':
            return compileExpression([], ([]) => [ast.value]);
        case 'ternary': {
            const comparatorC = recurse({ ast: ast.condition });
            const ifTrueC = recurse({ ast: ast.ifTrue });
            const ifFalseC = recurse({ ast: ast.ifFalse });
            return compileExpression([comparatorC, ifTrueC, ifFalseC], ([compare, ifTrue, ifFalse]) => [
                ...compare,
                '?',
                ...ifTrue,
                ':',
                ...ifFalse,
            ]);
        }
        case 'equality': {
            const lhs = recurse({ ast: ast.lhs });
            const rhs = recurse({ ast: ast.rhs });
            if (ast.type.name == 'String') {
                return compileExpression([lhs, rhs], ([e1, e2]) => ['string_compare(', ...e1, ',', ...e2, ')']);
            } else {
                return compileExpression([lhs, rhs], ([e1, e2]) => [...e1, '==', ...e2]);
            }
        }
        case 'booleanLiteral':
            return compileExpression([], ([]) => [ast.value ? '1' : '0']);
        case 'stringLiteral':
            const stringLiteralData = stringLiterals.find(({ value }) => value == ast.value);
            if (!stringLiteralData) throw debug();
            return compileExpression([], ([]) => [stringLiteralName(stringLiteralData)]);
        default:
            debug();
    }
    return debug();
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
    variables: any;
    globalDeclarations: any;
    stringLiterals: StringLiteralData[];
    buildSignature: SignatureBuilder;
    returnType: any;
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
    if (returnStatement.kind !== 'returnStatement') throw debug();
    const body = nonReturnStatements.map(statement => {
        const statementLogic = astToC({
            ast: statement,
            globalDeclarations,
            stringLiterals,
            localDeclarations: variables,
        });
        return join(
            [join(statementLogic.prepare, '\n'), join(statementLogic.execute, ' '), join(statementLogic.cleanup, '\n')],
            '\n'
        );
    });
    const endOfFunctionFrees = variables
        // TODO: Make a better memory model for dynamic/global frees.
        .filter(s => s.location === 'Stack')
        .filter(s => s.type.name == 'String')
        .map(s => callFree(s.name, 'Freeing Stack String at end of function'));
    const returnCode = astToC({
        ast: returnStatement.expression,
        globalDeclarations,
        stringLiterals,
        localDeclarations: variables,
    });
    return join(
        [
            buildSignature(name, parameters),
            '{',
            ...body,
            ...returnCode.prepare,
            `${mplTypeToCDeclaration(returnType, 'result')} = ${join(returnCode.execute, ' ')};`,
            ...returnCode.cleanup,
            ...endOfFunctionFrees,
            ...beforeExit,
            `return result;`,
            '}',
        ],
        '\n'
    );
};

const toExectuable = ({ functions, program, globalDeclarations, stringLiterals }: BackendInputs) => {
    const Cfunctions = functions.map(({ name, parameters, statements, variables }) =>
        makeCfunctionBody({
            name,
            parameters,
            statements,
            variables,
            globalDeclarations,
            stringLiterals,
            buildSignature: (name, parameters) => {
                const parameterDeclarations = parameters.map(p => mplTypeToCDeclaration(p.type, p.name));
                return `unsigned char ${name}(${join(parameterDeclarations, ', ')})`;
            },
            returnType: { name: 'Integer' }, // Can currently only return integer
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
        returnType: { name: 'Integer' }, // Main can only ever return integer
        beforeExit: ['verify_no_leaks();'],
    });
    const Cdeclarations = globalDeclarations
        .map(declaration => mplTypeToCDeclaration(declaration.type, declaration.name))
        .map(cDeclaration => `${cDeclaration};`);

    return `
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

${join(stringLiterals.map(stringLiteralDeclaration), '\n')}
${join(Cdeclarations, '\n')}
${join(Cfunctions, '\n')}
${Cprogram}
`;
};

const execute = async (path: string): Promise<ExecutionResult> => {
    const exeFile = await tmpFile();
    try {
        await exec(`clang -Wall -Werror ${path} -o ${exeFile.path}`);
    } catch (e) {
        return { error: `Failed to compile generated C code:\n${e.stderr}` };
    }
    try {
        return execAndGetResult(exeFile.path);
    } catch (e) {
        return {
            error: e,
        };
    }
};

/*
const debugWithLldb = async path => {
    const exeFile = await tmpFile();
    try {
        await exec(`clang -Wall -Werror ${path} -g -o ${exeFile.path}`);
    } catch (e) {
        return { error: `Failed to compile generated C code:\n${e.stderr}` };
    }
    return exec(`lldb ${exeFile.path}`);
};
*/

export default {
    toExectuable,
    execute,
    name: 'c',
    //debug: debugWithLldb,
};
