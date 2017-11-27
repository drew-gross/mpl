import { file as tmpFile} from 'tmp-promise';
import { VariableDeclaration, Type, BackendInputs, Function, ExecutionResult } from '../api.js';
import flatten from '../util/list/flatten.js';
import { typeOfExpression } from '../frontend.js';
import { exec } from 'child-process-promise';
import execAndGetResult from '../util/execAndGetResult.js';
import debug from '../util/debug.js';

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

const astToC = ({
    ast,
    globalDeclarations,
    stringLiterals,
    localDeclarations,
}: BackendInput): string[] => {
    if (!ast) debug();
    switch (ast.type) {
        case 'returnStatement': return [
            `return`,
            ...astToC({ ast: ast.children[1], globalDeclarations, stringLiterals, localDeclarations }),
            ';',
        ];
        case 'number': return [ast.value.toString()];
        case 'product': {
            return [
                ...astToC({ ast: ast.children[0], globalDeclarations, stringLiterals, localDeclarations }),
                '*',
                ...astToC({ ast: ast.children[1], globalDeclarations, stringLiterals, localDeclarations }),
            ];
        }
        case 'subtraction': return [
            ...astToC({ ast: ast.children[0], globalDeclarations, stringLiterals, localDeclarations }),
            '-',
            ...astToC({ ast: ast.children[1], globalDeclarations, stringLiterals, localDeclarations }),
        ];
        case 'statement': return flatten(ast.children.map(child => astToC({ ast: child, globalDeclarations, stringLiterals, localDeclarations })));
        case 'statementSeparator': return [];
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
                        return [`${lhs} = `, ...rhs, `;`];
                    case 'String': {
                        return [
                            `// Alloate space for string, including null terminator`,
                            `${lhs} = my_malloc(length(${rhs}) + 1);`,
                            `string_copy(${rhs}, ${lhs});`,
                        ];
                    }
                    case 'Integer':
                        return [`${lhs} = `, ...rhs, `;`];
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
                        return [`${mplTypeToCDeclaration(declaration.type, lhs)} = `, ...rhs, `;`];
                    case 'String':
                        switch (declaration.memoryCategory) {
                            case 'Dynamic': return [
                                `// Alloate space for string, including null terminator`,
                                `${mplTypeToCDeclaration(declaration.type, lhs)} = my_malloc(length(${rhs}) + 1);`,
                                `string_copy(${rhs}, ${lhs});`,
                            ];
                            case 'GlobalStatic': return [
                                `${mplTypeToCDeclaration(declaration.type, lhs)} = `, ...rhs, `;`,
                            ]
                            default: debug();
                        }
                    default: debug();
                }
            }
        }
        case 'functionLiteral': return [`&${ast.value}`];
        case 'callExpression': return [
            `(*${ast.children[0].value})(`,
            ...astToC({ ast: ast.children[2], globalDeclarations, stringLiterals, localDeclarations }),
            `)`,
        ];
        case 'identifier': return [ast.value];
        case 'ternary': return [
            ...astToC({ ast: ast.children[0], globalDeclarations, stringLiterals, localDeclarations }),
            '?',
            ...astToC({ ast: ast.children[2], globalDeclarations, stringLiterals, localDeclarations }),
            ':',
            ...astToC({ ast: ast.children[4], globalDeclarations, stringLiterals, localDeclarations }),
        ];
        case 'equality': return [
            ...astToC({ ast: ast.children[0], globalDeclarations, stringLiterals, localDeclarations }),
            '==',
            ...astToC({ ast: ast.children[2], globalDeclarations, stringLiterals, localDeclarations }),
        ];
        case 'stringEquality': {
            const lhs = astToC({ ast: ast.children[0], globalDeclarations, stringLiterals, localDeclarations }).join('');
            const rhs = astToC({ ast: ast.children[2], globalDeclarations, stringLiterals, localDeclarations }).join('');
            return [`string_compare(${lhs}, ${rhs})`];
        }
        case 'booleanLiteral': return [ast.value == 'true' ? '1' : '0'];
        case 'stringLiteral': return [`string_literal_${ast.value}`];
        default: debug();
    };
    return debug();
};

const stringLiteralDeclaration = stringLiteral => `char *string_literal_${stringLiteral} = "${stringLiteral}";`;

const toExectuable = ({
    functions,
    program,
    globalDeclarations,
    stringLiterals,
}: BackendInputs) => {
    let Cfunctions = functions.map(({ name, argument, statements, variables }) => {
        const prefix = `unsigned char ${name}(unsigned char ${argument.children[0].value}) {`;
        const suffix = `}`;

        const body = statements.map(statement => {
            return astToC({
                ast: statement,
                globalDeclarations,
                stringLiterals,
                localDeclarations: variables,
            }).join(' ');
        });

        return [
            prefix,
            ...body,
            suffix,
        ].join(' ');
    });
    const nonReturnStatements = program.statements.slice(0, program.statements.length - 1);
    const returnStatement = program.statements[program.statements.length - 1];
    let Cprogram = flatten(nonReturnStatements.map(child => astToC({
        ast: child,
        globalDeclarations,
        stringLiterals,
        localDeclarations: program.variables,
    })));
    let CprogramFrees = program.variables
        // TODO: Make a better memory model for dynamic/global frees.
        // .filter(s => s.memoryCategory === 'Dynamic')
        .filter(s => s.type.name == 'String')
        .map(s => `my_free(${s.name});`);
    let CcreateResult = astToC({
        ast: (returnStatement as any).children[1],
        globalDeclarations,
        stringLiterals,
        localDeclarations: program.variables,
    });
    // Only Integers can be returned from main program
    let CassignResult = `${mplTypeToCDeclaration({ name: 'Integer' }, 'result')} = ${CcreateResult.join('\n')};`;
    let CreturnResult = `return result;`;

    let Cdeclarations = globalDeclarations
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

${Cdeclarations.join('\n')}
${Cfunctions.join('\n')}
${stringLiterals.map(stringLiteralDeclaration).join('\n')}

int main(int argc, char **argv) {
    ${Cprogram.join('\n')}
    ${CassignResult}
    ${CprogramFrees.join('\n')}
    verify_no_leaks();
    ${CreturnResult}
}
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
