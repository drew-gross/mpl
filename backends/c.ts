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
        default: debug();
    }
};

type BackendInput = {
    ast: any,
    globalDeclarations: VariableDeclaration[],
    localDeclarations: VariableDeclaration[],
    stringLiterals: string[],
};

type AstToCResult = {
    cPreExpression: string[],
    cExpression: string[],
    cPostExpression: string[],
}

/* TODO: make and use cConcat = (p1, expr => p2) => {
    const newC = cb(p1.cExpr);
    return {
        cPre: p1.pre ++ newC.pre
        cLogic: newC.logic,
        cPost: newC.post ++ p1.post
    }
};*/

const astToC = ({
    ast,
    globalDeclarations,
    stringLiterals,
    localDeclarations,
}: BackendInput): AstToCResult => {
    if (!ast) debug();
    switch (ast.type) {
        case 'returnStatement': {
            const subExpression = astToC({ ast: ast.children[1], globalDeclarations, stringLiterals, localDeclarations });
            return {
                cPreExpression: subExpression.cPreExpression,
                cExpression: [
                    'return',
                    ...subExpression.cExpression,
                    ';',
                ],
                cPostExpression: subExpression.cPostExpression,
            };
        }
        case 'number': return {
            cPreExpression: [],
            cExpression: [ast.value.toString()],
            cPostExpression: [],
        };
        case 'product': {
            const lhs = astToC({ ast: ast.children[0], globalDeclarations, stringLiterals, localDeclarations });
            const rhs = astToC({ ast: ast.children[1], globalDeclarations, stringLiterals, localDeclarations });
            return {
                cPreExpression: [...lhs.cPreExpression, ...rhs.cPreExpression],
                cExpression: [...lhs.cExpression, '*', ...rhs.cExpression],
                cPostExpression: [...lhs.cPostExpression, ...rhs.cPostExpression],
            };
        }
        case 'subtraction': {
            const lhs = astToC({ ast: ast.children[0], globalDeclarations, stringLiterals, localDeclarations });
            const rhs = astToC({ ast: ast.children[1], globalDeclarations, stringLiterals, localDeclarations });
            return {
                cPreExpression: [...lhs.cPreExpression, ...rhs.cPreExpression],
                cExpression: [...lhs.cExpression, '-', ...rhs.cExpression],
                cPostExpression: [...lhs.cPostExpression, ...rhs.cPostExpression],
            };
        }
        case 'concatenation': {
            const lhs = astToC({ ast: ast.children[0], globalDeclarations, stringLiterals, localDeclarations });
            const rhs = astToC({ ast: ast.children[2], globalDeclarations, stringLiterals, localDeclarations });
            return {
                cPreExpression: [
                    ...lhs.cPreExpression,
                    ...rhs.cPreExpression,
                    `char *temporary_string = my_malloc(length(${join(lhs.cExpression, ' ')}) + length(${join(rhs.cExpression, ' ')}) + 1);`
                ],
                cExpression: [
                    'string_concatenate(',
                    ...lhs.cExpression,
                    ', ',
                    ...rhs.cExpression,
                    ', temporary_string)',
                ],
                cPostExpression: ['my_free(temporary_string);', ...rhs.cPostExpression, ...lhs.cPostExpression],
            };
        };
        case 'statement': {
            const childResults = ast.children.map(child => astToC({
                ast: child,
                globalDeclarations,
                stringLiterals,
                localDeclarations,
            }));

            return {
                cPreExpression: flatten(childResults.map(r => r.cPreExpression)),
                cExpression: flatten(childResults.map(r => r.cExpression)),
                cPostExpression: flatten(childResults.map(r => r.cPostExpression)),
            };
        }
        case 'statementSeparator': return {
            cPreExpression: [],
            cExpression: [],
            cPostExpression: [],
        };
        case 'typedAssignment':
        case 'assignment': {
            const rhsIndex = ast.type === 'assignment' ? 2 : 4;
            const lhs = ast.children[0].value;
            const rhs = astToC({ ast: ast.children[rhsIndex], globalDeclarations, stringLiterals, localDeclarations });
            if (globalDeclarations.some(declaration => declaration.name === lhs)) {
                const declaration = globalDeclarations.find(declaration => declaration.name === lhs);
                if (!declaration) throw debug();
                switch (declaration.type.name) {
                    case 'Function':
                        return {
                            cPreExpression: rhs.cPreExpression,
                            cExpression: [`${lhs} = `, ...rhs.cExpression, `;`],
                            cPostExpression: rhs.cPostExpression,
                        };
                    case 'String': {
                        return {
                            cPreExpression: rhs.cPreExpression,
                            cExpression: [
                                `${lhs} = my_malloc(length(${rhs.cExpression}) + 1);`,
                                `string_copy(${rhs.cExpression}, ${lhs});`,
                            ],
                            cPostExpression: rhs.cPostExpression,
                        };
                    }
                    case 'Integer': {
                        return {
                            cPreExpression: rhs.cPreExpression,
                            cExpression: [`${lhs} = `, ...rhs.cExpression, `;`],
                            cPostExpression: rhs.cPostExpression,
                        };
                    }
                    default: debug();
                }
            } else {
                const declaration = localDeclarations.find(declaration => declaration.name === lhs);
                if (!declaration) throw debug();
                if (!declaration.type) throw debug();
                if (!declaration.type.name) throw debug();
                switch (declaration.type.name) {
                    case 'Function':
                    case 'Integer':
                        return {
                            cPreExpression: rhs.cPreExpression,
                            cExpression: [`${mplTypeToCDeclaration(declaration.type, lhs)} = `, ...rhs.cExpression, `;`],
                            cPostExpression: rhs.cPostExpression,
                        };
                    case 'String':
                        switch (declaration.memoryCategory) {
                            case 'Stack':
                            case 'Dynamic': {
                                return {
                                    cPreExpression: rhs.cPreExpression,
                                    cExpression: [
                                        `// Alloate space for string, including null terminator\n`,
                                        `${mplTypeToCDeclaration(declaration.type, lhs)} = my_malloc(length(${join(rhs.cExpression, ' ')}) + 1);`,
                                        `string_copy(`,
                                         ...rhs.cExpression,
                                         `, ${lhs});`,
                                    ],
                                    cPostExpression: rhs.cPostExpression,
                                };
                            };
                            case 'GlobalStatic': {
                                return {
                                    cPreExpression: rhs.cPreExpression,
                                    cExpression: [`${mplTypeToCDeclaration(declaration.type, lhs)} = `, ...rhs.cExpression, `;`],
                                    cPostExpression: rhs.cPostExpression
                                }
                            };
                            default: debug();
                        }
                    default: debug();
                }
            }
        }
        case 'functionLiteral': return {
            cPreExpression: [],
            cExpression: [`&${ast.value}`],
            cPostExpression: [],
        }
        case 'callExpression': {
            const argC = astToC({ ast: ast.children[2], globalDeclarations, stringLiterals, localDeclarations });
            return {
                cPreExpression: argC.cPreExpression,
                cExpression: [
                    `(*${ast.children[0].value})(`,
                    ...argC.cExpression,
                    `)`,
                ],
                cPostExpression: argC.cPostExpression,
            };
        };
        case 'identifier': return {
            cPreExpression: [],
            cExpression: [ast.value],
            cPostExpression: [],
        };
        case 'ternary': {
            const comparatorC = astToC({ ast: ast.children[0], globalDeclarations, stringLiterals, localDeclarations });
            const ifTrueC = astToC({ ast: ast.children[2], globalDeclarations, stringLiterals, localDeclarations });
            const ifFalseC = astToC({ ast: ast.children[4], globalDeclarations, stringLiterals, localDeclarations });
            return {
                cPreExpression: [
                    ...comparatorC.cPreExpression,
                    ...ifTrueC.cPreExpression,
                    ...ifFalseC.cPreExpression,
                ],
                cExpression: [
                    ...comparatorC.cExpression,
                    '?',
                    ...ifTrueC.cExpression,
                    ':',
                    ...ifFalseC.cExpression,
                ],
                cPostExpression: [
                    ...ifFalseC.cPostExpression,
                    ...ifTrueC.cPostExpression,
                    ...comparatorC.cPostExpression,
                ],
            };
        };
        case 'equality': {
            const lhs = astToC({ ast: ast.children[0], globalDeclarations, stringLiterals, localDeclarations });
            const rhs = astToC({ ast: ast.children[2], globalDeclarations, stringLiterals, localDeclarations });
            return {
                cPreExpression: [...lhs.cPreExpression, ...rhs.cPreExpression],
                cExpression: [
                    ...lhs.cExpression,
                    '==',
                    ...rhs.cExpression,
                ],
                cPostExpression: [...rhs.cPostExpression, ...lhs.cPostExpression],
            };
        };
        case 'stringEquality': {
            const lhs = astToC({ ast: ast.children[0], globalDeclarations, stringLiterals, localDeclarations });
            const rhs = astToC({ ast: ast.children[2], globalDeclarations, stringLiterals, localDeclarations });
            return {
                cPreExpression: [...lhs.cPreExpression, ...rhs.cPreExpression],
                cExpression: [
                    'string_compare(',
                    ...lhs.cExpression,
                    ',',
                    ...rhs.cExpression,
                    ')',
                ],
                cPostExpression: [...rhs.cPreExpression, ...lhs.cPostExpression],
            };
        }
        case 'booleanLiteral': return {
            cPreExpression: [],
            cExpression: [ast.value == 'true' ? '1' : '0'],
            cPostExpression: [],
        };
        case 'stringLiteral': return {
            cPreExpression: [],
            cExpression: [`string_literal_${ast.value}`],
            cPostExpression: [],
        };
        default: debug();
    };
    return debug();
};

const stringLiteralDeclaration = stringLiteral => `char *string_literal_${stringLiteral} = "${stringLiteral}";`;

type MakeCFunctionBodyInputs = {
    name: any,
    argument: any,
    statements: any,
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
    const body = nonReturnStatements.map(statement => {
        const statementLogic = astToC({
            ast: statement,
            globalDeclarations,
            stringLiterals,
            localDeclarations: variables,
        });
        return join([
            join(statementLogic.cPreExpression, '\n'),
            join(statementLogic.cExpression, ' '),
            join(statementLogic.cPostExpression, '\n'),
        ], '\n');
    });
    const frees = variables
        // TODO: Make a better memory model for dynamic/global frees.
        .filter(s => s.memoryCategory !== 'GlobalStatic')
        .filter(s => s.type.name == 'String')
        .map(s => `my_free(${s.name});`);
    const returnCode = astToC({
        ast: returnStatement.children[1],
        globalDeclarations,
        stringLiterals,
        localDeclarations: variables,
    });
    return join([
        buildSignature(name, argument),
        '{',
        ...body,
        ...returnCode.cPreExpression,
        `${mplTypeToCDeclaration(returnType, 'result')} = ${join(returnCode.cExpression, ' ')};`,
        ...returnCode.cPostExpression,
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
        buildSignature: (name, argument) => `unsigned char ${name}(unsigned char ${argument.children[0].value})`,
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

void string_copy(char *in, char *out) {
    while ((*out++ = *in++)) {}
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
