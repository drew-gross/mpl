import * as Ast from '../ast.js';
import { file as tmpFile} from 'tmp-promise';
import { VariableDeclaration, Type, BackendInputs, Function, ExecutionResult } from '../api.js';
import flatten from '../util/list/flatten.js';
import { typeOfExpression } from '../frontend.js';
import { exec } from 'child-process-promise';
import execAndGetResult from '../util/execAndGetResult.js';
import debug from '../util/debug.js';
import join from '../util/join.js';

const mplTypeToCDeclaration = (type: Type, name: string) => {
    if (!type) debug();
    switch (type.name) {
        case 'Function': return `unsigned char (*${name})(unsigned char)`
        case 'Integer': return `uint8_t ${name}`;
        case 'String': return `char *${name}`;
        default: throw debug();
    }
};

type BackendInput = {
    ast: Ast.LoweredAst,
    globalDeclarations: VariableDeclaration[],
    localDeclarations: VariableDeclaration[],
    stringLiterals: string[],
};

type CompiledExpression = {
    prepare: string[],
    execute: string[],
    cleanup: string[],
}

type CompiledAssignment = {
    prepare: string[],
    execute: string[],
    cleanup: string[],
}

type CompiledProgram = {
    prepare: string[],
    execute: string[],
    cleanup: string[],
}

type ExpressionCompiler = (expressions: string[][]) => string[];

const compileExpression = (
    subExpressions: CompiledExpression[],
    expressionCompiler: ExpressionCompiler
): CompiledExpression => ({
    prepare: flatten(subExpressions.map(input => input.prepare)),
    execute: expressionCompiler(subExpressions.map(input => input.execute)),
    cleanup: flatten(subExpressions.map(input => input.cleanup)).reverse(),
});

const compileAssignment = (
    destination: string,
    rhs: CompiledExpression,
): CompiledAssignment => {
    return {
        prepare: rhs.prepare,
        execute: [`${destination} = `, ...rhs.execute, ';'],
        cleanup: rhs.cleanup,
    };
}

const astToC = ({
    ast,
    globalDeclarations,
    stringLiterals,
    localDeclarations,
}: BackendInput): CompiledProgram => {
    if (!ast) debug();
    switch (ast.kind) {
        case 'returnStatement': {
            const subExpression = astToC({ ast: ast.expression, globalDeclarations, stringLiterals, localDeclarations });
            return compileExpression([subExpression], ([e1]) => ['return', ...e1, ';']);
        }
        case 'number': return compileExpression([], ([]) => [ast.value.toString()]);
        case 'product': {
            const lhs = astToC({ ast: ast.lhs, globalDeclarations, stringLiterals, localDeclarations });
            const rhs = astToC({ ast: ast.rhs, globalDeclarations, stringLiterals, localDeclarations });
            return compileExpression([lhs, rhs], ([e1, e2]) => [...e1, '*', ...e2]);
        }
        case 'subtraction': {
            const lhs = astToC({ ast: ast.lhs, globalDeclarations, stringLiterals, localDeclarations });
            const rhs = astToC({ ast: ast.rhs, globalDeclarations, stringLiterals, localDeclarations });
            return compileExpression([lhs, rhs], ([e1, e2]) => [...e1, '-', ...e2]);
        }
        case 'concatenation': {
            const lhs = astToC({ ast: ast.lhs, globalDeclarations, stringLiterals, localDeclarations });
            const rhs = astToC({ ast: ast.rhs, globalDeclarations, stringLiterals, localDeclarations });
            const prepAndCleanup = {
                prepare: [`char *temporary_string = my_malloc(length(${join(lhs.execute, ' ')}) + length(${join(rhs.execute, ' ')}) + 1);`],
                execute: [],
                cleanup: ['my_free(temporary_string);'],
            }
            return compileExpression(
                [lhs, rhs, prepAndCleanup],
                ([e1, e2, _]) => ['string_concatenate(', ...e1, ', ', ...e2,', temporary_string)']
            );
        };
        case 'statement': {
            const childResults = ast.children.map(child => astToC({
                ast: child,
                globalDeclarations,
                stringLiterals,
                localDeclarations,
            }));

            return compileExpression(childResults, flatten);
        }
        case 'typedAssignment': {
            const lhs = ast.destination;
            const rhs = astToC({ ast: ast.expression, globalDeclarations, stringLiterals, localDeclarations });
            if (globalDeclarations.some(declaration => declaration.name === lhs)) {
                const declaration = globalDeclarations.find(declaration => declaration.name === lhs);
                if (!declaration) throw debug();
                switch (declaration.type.name) {
                    case 'Function': return compileAssignment(lhs, rhs);
                    case 'String': {
                        const rhsWillAlloc = compileExpression([rhs], ([e]) => [
                                `string_copy(${e}, my_malloc(length(${e}) + 1));`,
                            ])
                        return compileAssignment(lhs, rhsWillAlloc);
                    }
                    case 'Integer': return compileAssignment(lhs, rhs);
                    default: debug();
                }
            } else {
                const declaration = localDeclarations.find(declaration => declaration.name === lhs);
                if (!declaration) throw debug();
                if (!declaration.type) throw debug();
                if (!declaration.type.name) throw debug();
                switch (declaration.type.name) {
                    case 'Function':
                    case 'Integer': return compileAssignment(mplTypeToCDeclaration(declaration.type, lhs), rhs);
                    case 'String':
                        switch (declaration.memoryCategory) {
                            case 'Stack':
                            case 'Dynamic': {
                                const rhsWillAlloc = compileExpression(
                                    [rhs],
                                    ([e1]) => ['string_copy(', ...e1, ', my_malloc(length(', ...e1, ') + 1))'],
                                );
                                return compileAssignment(mplTypeToCDeclaration(declaration.type, lhs), rhsWillAlloc);
                            };
                            case 'GlobalStatic': return compileAssignment(mplTypeToCDeclaration(declaration.type, lhs), rhs);
                            default: debug();
                        }
                    default: debug();
                }
            }
            throw debug();

        }
        case 'functionLiteral': return compileExpression([], ([]) => [`&${ast.deanonymizedName}`]);
        case 'callExpression': {
            const argC = astToC({ ast: ast.argument, globalDeclarations, stringLiterals, localDeclarations });
            return compileExpression([argC], ([e1]) => [`(*${ast.name})(`, ...e1, ')']);
        };
        case 'identifier': return compileExpression([], ([]) => [ast.value]);
        case 'ternary': {
            const comparatorC = astToC({ ast: ast.condition, globalDeclarations, stringLiterals, localDeclarations });
            const ifTrueC = astToC({ ast: ast.ifTrue, globalDeclarations, stringLiterals, localDeclarations });
            const ifFalseC = astToC({ ast: ast.ifFalse, globalDeclarations, stringLiterals, localDeclarations });
            return compileExpression(
                [comparatorC, ifTrueC, ifFalseC],
                ([compare, ifTrue, ifFalse]) => [...compare, '?', ...ifTrue, ':', ...ifFalse]
            );
        };
        case 'equality': {
            const lhs = astToC({ ast: ast.lhs, globalDeclarations, stringLiterals, localDeclarations });
            const rhs = astToC({ ast: ast.rhs, globalDeclarations, stringLiterals, localDeclarations });
            return compileExpression([lhs, rhs], ([e1, e2]) => [...e1, '==', ...e2]);
        };
        case 'stringEquality': {
            const lhs = astToC({ ast: ast.lhs, globalDeclarations, stringLiterals, localDeclarations });
            const rhs = astToC({ ast: ast.rhs, globalDeclarations, stringLiterals, localDeclarations });
            return compileExpression([lhs, rhs], ([e1, e2]) => ['string_compare(', ...e1, ',', ...e2, ')']);
        }
        case 'booleanLiteral': return compileExpression([], ([]) => [ast.value ? '1' : '0']);
        case 'stringLiteral': return compileExpression([], ([]) => [`string_literal_${ast.value}`]);
        default: debug();
    };
    return debug();
};

const stringLiteralDeclaration = stringLiteral => `char *string_literal_${stringLiteral} = "${stringLiteral}";`;

type MakeCFunctionBodyInputs = {
    name: any,
    argument: any,
    statements: Ast.LoweredAst[],
    variables: any,
    globalDeclarations: any,
    stringLiterals: any,
    buildSignature: any,
    returnType: any,
    beforeExit?: string[],
}

const makeCfunctionBody = ({
    name,
    argument,
    statements,
    variables,
    globalDeclarations,
    stringLiterals,
    buildSignature,
    returnType,
    beforeExit = []
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
        return join([
            join(statementLogic.prepare, '\n'),
            join(statementLogic.execute, ' '),
            join(statementLogic.cleanup, '\n'),
        ], '\n');
    });
    const frees = variables
        // TODO: Make a better memory model for dynamic/global frees.
        .filter(s => s.memoryCategory !== 'GlobalStatic')
        .filter(s => s.type.name == 'String')
        .map(s => `my_free(${s.name});`);
    const returnCode = astToC({
        ast: returnStatement.expression,
        globalDeclarations,
        stringLiterals,
        localDeclarations: variables,
    });
    return join([
        buildSignature(name, argument),
        '{',
        ...body,
        ...returnCode.prepare,
        `${mplTypeToCDeclaration(returnType, 'result')} = ${join(returnCode.execute, ' ')};`,
        ...returnCode.cleanup,
        ...frees,
        ...beforeExit,
        `return result;`,
        '}',
    ], '\n');
}

const toExectuable = ({
    functions,
    program,
    globalDeclarations,
    stringLiterals,
}: BackendInputs) => {
    const Cfunctions = functions.map(({ name, argument, statements, variables }) => makeCfunctionBody({
        name,
        argument,
        statements,
        variables,
        globalDeclarations,
        stringLiterals,
        buildSignature: (name, argument) => `unsigned char ${name}(unsigned char ${argument.name})`,
        returnType: { name: 'Integer' }, // Can currently only return integer
    }));
    const Cprogram = makeCfunctionBody({
        name: 'main', // Unused for now
        argument: {} as any, // Unused for now
        statements: program.statements,
        variables: program.variables,
        globalDeclarations,
        stringLiterals,
        buildSignature: (_1, _2) => 'int main(int argc, char **argv)',
        returnType: { name: 'Integer' }, // Main can only ever return integer
        beforeExit: [
            ...globalDeclarations
                .filter(declaration => declaration.type.name === 'String')
                .map(declaration => `my_free(${declaration.name});`),
            'verify_no_leaks();',
        ],
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

void *my_malloc(size_t requested_size) {
    // Error out if we request zero bytes, that should never happen
    if (requested_size == 0) {
        printf("Zero memory requested! Exiting.");
        exit(-1);
    }

    struct block_info *current_block = first_block;
    struct block_info *previous_block = NULL;

    // Find the first free block that is large enough
    while (current_block != NULL && current_block->free == false && current_block->size >= requested_size) {
        previous_block = current_block;
        current_block = current_block->next_block;
    }

    if (current_block == NULL) {
        // No large enough blocks. Use sbrk to create a new one TODO: Switch to mmap on mac, sbrk is deprecated
        #pragma clang diagnostic ignored "-Wdeprecated-declarations"
        struct block_info *newly_allocated = (struct block_info*)sbrk(requested_size + sizeof(struct block_info));
        if (newly_allocated == (void*)-1) {
            printf("Memory allocation failed! Exiting.");
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
        printf("Tried to free null pointer! Exiting.");
        exit(-1);
    }
    // TODO: Merge blocks
    // Get a pointer to the space after the block info (-1 actually subtracts sizeof(struct block_info))
    struct block_info *block_to_free = ((struct block_info *)pointer) - 1;
    block_to_free->free = true;
}

// Run through blocks and make sure they are free. For debugging.
void verify_no_leaks() {
    struct block_info *current_block = first_block;
    while (current_block != NULL) {
        if (!current_block->free) {
            printf("Unfreed memory detected! Exiting.");
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

export default {
    toExectuable,
    execute,
    name: 'c',
};
