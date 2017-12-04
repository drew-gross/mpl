import { exec } from 'child-process-promise';
import flatten from '../util/list/flatten.js';
import { VariableDeclaration, BackendInputs, ExecutionResult } from '../api.js';
import * as Ast from '../ast.js';
import debug from '../util/debug.js';

// 's' registers are used for the args, starting as 0. Spill recovery shall start at the last (7)
const argument1 = '$s0';
const argument2 = '$s1';
const syscallArg1 = '$a0';
const syscallArg2 = '$a1';
const syscallResult = '$v0';
const syscallSelect = '$v0';

const storeLiteralMips = ({ type, destination, spOffset }, value) => {
    if (type == undefined) debug();
    switch (type) {
        case 'register': return `li ${destination}, ${value}`;
        case 'memory': return [
            `li $s7, ${value}`,
            `sw $s7, -${spOffset}($sp)`
        ].join('\n');
        default: debug(); return '';
    }
}

const subtractMips = ({ type, destination }, left, right) => {
    switch (type) {
        case 'register': return `sub ${destination}, ${left.destination}, ${right.destination}`;
        default: debug(); return '';
    }
}

const moveMips = ({ type, destination }, source) => {
    switch (type) {
        case 'register': return `move ${destination}, ${source}`;
        default: debug(); return '';
    }
}

const loadAddressOfGlobal = ({ type, destination, spOffset }, value) => {
    switch (type) {
        case 'register': return `la ${destination}, ${value}`;
        default: debug(); return '';
    }
}

const loadGlobalMips = ({ type, destination, spOffset }, value) => {
    switch (type) {
        case 'register': return `lw ${destination}, ${value}`;
        default: debug(); return '';
    }
}

const multiplyMips = (destination, left, right) => {
    let leftRegister = left.destination;
    let loadSpilled: any = []
    let restoreSpilled: any = [];
    if (left.type == 'memory') {
        leftRegister = '$s1';
        loadSpilled.push(`lw $s1, -${left.spOffset}($sp)`);
    }

    let rightRegister = right.destination;
    if (right.type == 'memory') {
        rightRegister = '$s2';
        loadSpilled.push(`lw $s2, -${right.spOffset}($sp)`);
    }

    let destinationRegister = destination.destination;
    if (destination.type == 'memory') {
        destinationRegister = '$s3';
        restoreSpilled.push(`sw $s3, -${destination.spOffset}($sp)`);
    }
    if (leftRegister == '$tNaN') debug();

    return [
        ...loadSpilled,
        `mult ${leftRegister}, ${rightRegister}`,
        `# Move result to final destination (assume no overflow)`,
        `mflo ${destinationRegister}`,
        ...restoreSpilled,
    ].join('\n');
}

const mipsBranchIfEqual = (left, right, label) => {
    if (left.type !== 'register' || right.type !== 'register') debug();
    return `beq ${left.destination}, ${right.destination}, ${label}`
}

// TODO: global storage
type StorageSpec = { type: 'register', destination: string } | { type: 'memory', spOffset: number };

const nextTemporary = (storage: StorageSpec): StorageSpec => {
    if (storage.type == 'register') {
        if (storage.destination == '$t9') {
            // Now need to spill
            return {
                type: 'memory',
                spOffset: 0,
            };
        } else {
            return {
                type: 'register',
                destination: `$t${parseInt(storage.destination[storage.destination.length - 1]) + 1}`,
            };
        }
    } else if (storage.type == 'memory') {
        return {
            type: 'memory',
            spOffset: storage.spOffset + 4,
        }
    } else {
        return debug();
    }
};

const runtimeFunctions = ['length'];

let labelId = 0;

type AstToMipsOptions = {
    ast: Ast.LoweredAst,
    registerAssignment: any,
    destination: any,
    currentTemporary: any,
    globalDeclarations: VariableDeclaration[],
    stringLiterals: any,
};

const astToMips = ({
    ast,
    registerAssignment,
    destination,
    currentTemporary,
    globalDeclarations,
    stringLiterals,
}: AstToMipsOptions) => {
    if (!ast) debug();
    switch (ast.kind) {
        case 'returnStatement': return [
            `# evaluate expression of return statement, put in $a0`,
            ...astToMips({
                ast: ast.expression,
                registerAssignment,
                destination: {
                    type: 'register',
                    destination: '$a0',
                },
                currentTemporary,
                globalDeclarations,
                stringLiterals,
            }),
        ];
        case 'number': return [storeLiteralMips(destination, ast.value)];
        case 'booleanLiteral': return [storeLiteralMips(destination, ast.value ? '1' : '0')];
        case 'product': {
            const leftSideDestination = currentTemporary;
            const rightSideDestination = destination;
            const subExpressionTemporary = nextTemporary(currentTemporary);

            const storeLeftInstructions = astToMips({
                ast: ast.lhs,
                registerAssignment,
                destination: leftSideDestination,
                currentTemporary: subExpressionTemporary,
                globalDeclarations,
                stringLiterals,
            });
            const storeRightInstructions = astToMips({
                ast: ast.rhs,
                registerAssignment,
                destination: rightSideDestination,
                currentTemporary: subExpressionTemporary,
                globalDeclarations,
                stringLiterals,
            });
            return [
                `# Store left side of product in temporary (${leftSideDestination.destination})`,
                ...storeLeftInstructions,
                `# Store right side of product in destination (${rightSideDestination.destination})`,
                ...storeRightInstructions,
                `# Evaluate product`,
                multiplyMips(destination, leftSideDestination, rightSideDestination),
            ];
        }
        case 'subtraction': {
            const leftSideDestination = currentTemporary;
            const rightSideDestination = destination;
            const subExpressionTemporary = nextTemporary(currentTemporary);

            const storeLeftInstructions = astToMips({
                ast: ast.lhs,
                registerAssignment,
                destination: leftSideDestination,
                currentTemporary: subExpressionTemporary,
                globalDeclarations,
                stringLiterals,
            });
            const storeRightInstructions = astToMips({
                ast: ast.rhs,
                registerAssignment,
                destination: rightSideDestination,
                currentTemporary: subExpressionTemporary,
                globalDeclarations,
                stringLiterals,
            });
            return [
                `# Store left side in temporary (${leftSideDestination.destination})`,
                ...storeLeftInstructions,
                `# Store right side in destination (${rightSideDestination.destination})`,
                ...storeRightInstructions,
                `# Evaluate subtraction`,
                subtractMips(destination, leftSideDestination, rightSideDestination),
            ];
        }
        case 'statement': return flatten(ast.children.map(child => astToMips({
            ast: child,
            registerAssignment,
            destination: '(TODO: READ FROM REGISTER ASSIGNMENT)',
            currentTemporary,
            globalDeclarations,
            stringLiterals,
        })));
        case 'functionLiteral': {
            if (destination.type !== 'register') debug(); // TODO: Figure out how to guarantee this doesn't happen
            return [
                `# Loading function into register`,
                `la ${destination.destination}, ${ast.deanonymizedName}`
            ];
        }
        case 'callExpression': {
            if (currentTemporary.type !== 'register') debug(); // TODO: Figure out how to guarantee this doesn't happen
            const name = ast.name;
            let callInstructions: string[] = []
            if (runtimeFunctions.includes(name)) {
                callInstructions = [
                    `# Call runtime function`,
                    `la ${currentTemporary.destination}, ${name}`,
                    `jal ${currentTemporary.destination}`,
                ];
            } else if (globalDeclarations.some(declaration => declaration.name === name)) {
                callInstructions = [
                    `# Call global function`,
                    `lw ${currentTemporary.destination}, ${name}`,
                    `jal ${currentTemporary.destination}`,
                ];
            } else if (name in registerAssignment) {
                callInstructions = [
                    `# Call register function`,
                    `jal ${registerAssignment[name].destination}`,
                ];
            } else {
                debug();
            }

            return [
                `# Put argument in argument1`,
                ...astToMips({
                    ast: ast.argument,
                    registerAssignment,
                    destination: { type: 'register', destination: argument1 },
                    currentTemporary: nextTemporary(currentTemporary),
                    globalDeclarations,
                    stringLiterals,
                }),
                `# call ${name}`,
                ...callInstructions,
                `# move result from $a0 into destination`,
                moveMips(destination, '$a0'),
            ];
        }
        case 'typedAssignment': {
            const lhs = ast.destination;
            if (globalDeclarations.some(declaration => declaration.name === lhs)) {
                const declaration = globalDeclarations.find(declaration => declaration.name === lhs);
                if (!declaration) debug();
                switch ((declaration as any).type.name) {
                    case 'Function':
                        return [
                            `# Put function pointer into temporary`,
                            ...astToMips({
                                ast: ast.expression,
                                registerAssignment,
                                destination: currentTemporary,
                                currentTemporary,
                                globalDeclarations,
                                stringLiterals,
                            }),
                            `# Put function pointer into global`,
                            `sw ${currentTemporary.destination}, ${lhs}`,
                        ];
                    case 'Integer':
                        return [
                            `# Put integer pointer into temporary`,
                            ...astToMips({
                                ast: ast.expression,
                                registerAssignment,
                                destination: currentTemporary,
                                currentTemporary,
                                globalDeclarations,
                                stringLiterals,
                            }),
                            `# Store into global`,
                            `sw ${currentTemporary.destination}, ${lhs}`,
                        ];
                    case 'String':
                        return [
                            `# Put string pointer into temporary`,
                            ...astToMips({
                                ast: ast.expression,
                                registerAssignment,
                                destination: currentTemporary,
                                currentTemporary,
                                globalDeclarations,
                                stringLiterals,
                            }),
                            `# Store into global`,
                            `sw ${currentTemporary.destination}, ${lhs}`,
                        ];
                    default: throw debug();
                }
            } else if (lhs in registerAssignment) {
                return [
                    `# Run rhs of assignment and store to ${lhs} (${registerAssignment[lhs].destination})`,
                    ...astToMips({
                        ast: ast.expression,
                        registerAssignment,
                        // TODO: Allow spilling of variables
                        destination: {
                            type: 'register',
                            destination: `${registerAssignment[lhs].destination}`,
                        },
                        currentTemporary,
                        globalDeclarations,
                        stringLiterals,
                    }),
                ];
            } else {
                throw debug();
            }
        }
        case 'identifier': {
            // TODO: Better handle identifiers here. Also just better storage/scope chains?
            const identifierName = ast.value;
            if (globalDeclarations.some(declaration => declaration.name === identifierName)) {
                const declaration = globalDeclarations.find(declaration => declaration.name === identifierName);
                if (!declaration) {
                    debug();
                }
                return [
                    `# Move from global ${identifierName} into destination (${destination.destination || destination.spOffset})`,
                    loadGlobalMips(destination, identifierName),
                ];
            }
            const identifierRegister = registerAssignment[identifierName].destination;
            return [
                `# Move from ${identifierName} (${identifierRegister}) into destination (${destination.destination || destination.spOffset})`,
                moveMips(destination, identifierRegister),
            ];
        }
        case 'ternary': {
            const booleanTemporary = currentTemporary;
            const subExpressionTemporary = nextTemporary(currentTemporary);
            const falseBranchLabel = labelId;
            labelId++;
            const endOfTernaryLabel = labelId;
            labelId++;
            return [
                `# Compute boolean and store in temporary`,
                ...astToMips({
                    ast: ast.condition,
                    registerAssignment,
                    destination: booleanTemporary,
                    currentTemporary: subExpressionTemporary,
                    globalDeclarations,
                    stringLiterals,
                }),
                `# Go to false branch if zero`,
                mipsBranchIfEqual(booleanTemporary, { type: 'register', destination: '$0' }, `L${falseBranchLabel}`),
                `# Execute true branch`,
                ...astToMips({
                    ast: ast.ifTrue,
                    registerAssignment,
                    destination,
                    currentTemporary: subExpressionTemporary,
                    globalDeclarations,
                    stringLiterals,
                }),
                `# Jump to end of ternary`,
                `b L${endOfTernaryLabel}`,
                `L${falseBranchLabel}:`,
                `# Execute false branch`,
                ...astToMips({
                    ast: ast.ifFalse,
                    registerAssignment,
                    destination,
                    currentTemporary: subExpressionTemporary,
                    globalDeclarations,
                    stringLiterals,
                }),
                `# End of ternary label`,
                `L${endOfTernaryLabel}:`,
            ];
        }
        case 'equality': {
            const leftSideDestination = currentTemporary;
            const rightSideDestination = destination;
            const subExpressionTemporary = nextTemporary(currentTemporary);
            const storeLeftInstructions = astToMips({
                ast: ast.lhs,
                registerAssignment,
                destination: leftSideDestination,
                currentTemporary: subExpressionTemporary,
                globalDeclarations,
                stringLiterals,
            });

            const storeRightInstructions = astToMips({
                ast: ast.rhs,
                registerAssignment,
                destination: rightSideDestination,
                currentTemporary: subExpressionTemporary,
                globalDeclarations,
                stringLiterals,
            });

            const equalLabel = labelId;
            labelId++;
            const endOfConditionLabel = labelId;
            labelId++;

            let jumpIfEqualInstructions = [];

            return [
                `# Store left side of equality in temporary`,
                ...storeLeftInstructions,
                `# Store right side of equality in temporary`,
                ...storeRightInstructions,
                `# Goto set 1 if equal`,
                mipsBranchIfEqual(leftSideDestination, rightSideDestination, `L${equalLabel}`),
                `# Not equal, set 0`,
                storeLiteralMips(destination, '0'),
                `# And goto exit`,
                `b L${endOfConditionLabel}`,
                `L${equalLabel}:`,
                storeLiteralMips(destination, '1'),
                `L${endOfConditionLabel}:`,
            ];
        }
        case 'stringEquality': {
            // Put left in s0 and right in s1 for passing to string equality function
            const storeLeftInstructions = astToMips({
                ast: ast.lhs,
                registerAssignment,
                destination: {
                    type: 'register',
                    destination: argument1,
                },
                currentTemporary,
                globalDeclarations,
                stringLiterals,
            });
            const storeRightInstructions = astToMips({
                ast: ast.rhs,
                registerAssignment,
                destination: {
                    type: 'register',
                    destination: argument2,
                },
                currentTemporary,
                globalDeclarations,
                stringLiterals,
            });
            return [
                `# Store left side in s0`,
                ...storeLeftInstructions,
                `# Store right side in s1`,
                ...storeRightInstructions,
                `# Call stringEquality`,
                `jal stringEquality`,
                `# Return value in $a0. Move to destination`,
                moveMips(destination, '$a0'),
            ];
        }
        case 'stringLiteral': {
            return [
                `# Load string literal address into register`,
                loadAddressOfGlobal(destination, `string_constant_${ast.value}`),
            ];
        }
        case 'concatenation': debug();
        default:
            debug();

    }
}

const assignMipsRegisters = (variables: VariableDeclaration[]) => {
    // TODO: allow spilling of variables
    let currentRegister = 0;
    let registerAssignment = {};
    variables.forEach(variable => {
        registerAssignment[variable.name] = {
            type: 'register',
            destination: `$t${currentRegister}`,
        };
        currentRegister = currentRegister + 1;
    });
    return {
        registerAssignment,
        firstTemporary: {
            type: 'register',
            destination: `$t${currentRegister}`,
        },
    };
};

const saveRegistersCode = (numRegisters: number): string[] => {
    let result = [
        `# Always store return address`,
        `sw $ra, ($sp)`,
        `addiu $sp, $sp, -4`,
    ];
    while (numRegisters > 0) {
        result.push(`sw $t${numRegisters}, ($sp)`);
        result.push(`addiu $sp, $sp, -4`);
        numRegisters--;
    }
    return result;
};

const restoreRegistersCode = (numRegisters: number): string[] => {
    let result = [
        `lw $ra, ($sp)`,
        `addiu $sp, $sp, 4`,
        `# Always restore return address`,
    ];
    while (numRegisters > 0) {
        result.push(`lw $t${numRegisters}, ($sp)`);
        result.push(`addiu $sp, $sp, 4`);
        numRegisters--;
    }
    return result.reverse();
};

type ConstructMipsFunctionFirstArg = {
    name: any;
    argument: any;
    statements: Ast.LoweredAst[];
    temporaryCount: any;
}

const constructMipsFunction = ({ name, argument, statements, temporaryCount }: ConstructMipsFunctionFirstArg, globalDeclarations, stringLiterals) => {
    // Statments are either assign or return right now, so we need one register for each statement, minus the return statement.
    const scratchRegisterCount = temporaryCount + statements.length - 1;

    const registerAssignment: any = {
        [argument.name]: {
            type: 'register',
            destination: '$s0',
        },
    };

    let currentTemporary: StorageSpec = {
        type: 'register',
        destination: '$t1',
    };

    statements.forEach(statement => {
        if (statement.kind === 'typedAssignment') {
            registerAssignment[statement.destination] = currentTemporary;
            currentTemporary = nextTemporary(currentTemporary);
        }
    });

    const mipsCode = flatten(statements.map(statement => {
        return astToMips({
            ast: statement,
            registerAssignment,
            destination: '$a0',
            currentTemporary,
            globalDeclarations,
            stringLiterals,
        });
    }));
    return [
        `${name}:`,
        ...saveRegistersCode(scratchRegisterCount),
        `${mipsCode.join('\n')}`,
        ...restoreRegistersCode(scratchRegisterCount),
        `jr $ra`,
    ].join('\n');
}

const lengthRuntimeFunction = () => {
    const result = '$a0';
    const currentChar = '$t1';
    return `length:
    ${saveRegistersCode(1).join('\n')}

    # Set length count to 0
    li ${result}, 0
    length_loop:
    # Load char into temporary
    lb ${currentChar}, (${argument1})
    # If char is null, end of string. Return count.
    beq ${currentChar}, 0, length_return
    # Else bump pointer and count and return to start of loop
    addiu ${result}, ${result}, 1
    addiu ${argument1}, ${argument1}, 1
    b length_loop

    length_return:
    ${restoreRegistersCode(1).join('\n')}
    jr $ra`;
}

const stringEqualityRuntimeFunction = () => {
    const result = '$a0';
    const leftByte = '$t1';
    const rightByte = '$t2';
    return `stringEquality:
    ${saveRegistersCode(2).join('\n')}

    # Assume equal. Write 1 to $a0. Overwrite if difference found.
    li ${result}, 1

    # (string*, string*) -> bool
    stringEquality_loop:
    # load current chars into temporaries
    lb ${leftByte}, (${argument1})
    lb ${rightByte}, (${argument2})
    # Inequal: return false
    bne ${leftByte}, ${rightByte}, stringEquality_return_false
    # Now we know both sides are equal. If they equal null, string is over.
    # Return true. We already set ${result} to 1, so just goto end.
    beq ${leftByte}, 0, stringEquality_return
    # Otherwise, bump pointers and check next char
    addiu ${argument1}, 1
    addiu ${argument2}, 1
    b stringEquality_loop

    stringEquality_return_false:
    li ${result}, 0
    stringEquality_return:
    ${restoreRegistersCode(2).join('\n')}
    jr $ra`;
}

const myMallocRuntimeFunction = () => {
    const result = '$a0';
    const currentBlockPointer = '$t1';
    const previousBlockPointer = '$t2';
    const scratch = '$t3';
    return `my_malloc:
    ${saveRegistersCode(3).join('\n')}
    bne ${argument1}, 0, my_malloc_zero_size_check_passed
    la $a0, zero_memory_malloc_error
    li $v0, 4
    syscall
    li $v0, 10
    syscall
    my_malloc_zero_size_check_passed:

    la ${currentBlockPointer}, first_block
    la ${previousBlockPointer}, 0

    find_large_enough_free_block_loop:
    # no blocks left (will require sbrk)
    beq ${currentBlockPointer}, 0, find_large_enough_free_block_loop_exit
    # current block not free, try next
    lw ${scratch}, 2(${currentBlockPointer})
    beq ${scratch}, 0, advance_pointers
    # current block not large enough, try next
    lw ${scratch}, 0(${currentBlockPointer})
    bgt ${scratch}, ${argument1}, advance_pointers
    # We found a large enough block! Hooray!
    b find_large_enough_free_block_loop_exit

    advance_pointers:
    move ${previousBlockPointer}, ${currentBlockPointer}
    lw ${currentBlockPointer}, 1(${currentBlockPointer})
    b find_large_enough_free_block_loop

    find_large_enough_free_block_loop_exit:
    beq ${currentBlockPointer}, 0, sbrk_more_space

    # Found a reusable block, mark it as not free
    sw $0, 2(${currentBlockPointer})
    # add 3 to get actual space
    move ${result}, ${currentBlockPointer}
    addiu ${result}, 3
    b my_malloc_return

    sbrk_more_space:
    move ${syscallArg1}, ${argument1}
    # Include space for management block
    addiu ${syscallArg1}, 3
    li ${syscallSelect}, 9
    syscall
    # If sbrk failed, exit
    bne ${syscallResult}, -1, sbrk_exit_check_passed
    la $a0, sbrk_failed
    li $v0, 4
    syscall
    li $v0, 10
    syscall
    sbrk_exit_check_passed:

    # ${syscallResult} now contains pointer to block. Set up pointer to new block.
    lw ${scratch}, first_block
    bne ${scratch}, 0, assign_previous
    sw ${syscallResult}, first_block
    b set_up_new_space
    assign_previous:
    bne ${previousBlockPointer}, 0, set_up_new_space
    sw ${syscallResult}, 1(${previousBlockPointer})

    set_up_new_space:
    # Save size to new block
    sw ${argument1}, 0(${syscallResult})
    # Save next pointer = nullptr
    sw $0, 1(${syscallResult})
    # Not free as we are about to use it
    sw $0, 1(${syscallResult})
    move ${result}, ${syscallResult}
    # add 3 to get actual space
    addiu ${result}, 3

    my_malloc_return:
    ${restoreRegistersCode(3).join('\n')}
    `;
}

const toExectuable = ({
    functions,
    program,
    globalDeclarations,
    stringLiterals,
}: BackendInputs) => {
    let mipsFunctions = functions.map(f => constructMipsFunction(f,  globalDeclarations, stringLiterals));
    const {
        registerAssignment,
        firstTemporary,
    } = assignMipsRegisters(program.variables);
    let mipsProgram = flatten(program.statements.map(statement => astToMips({
        ast: statement,
        registerAssignment,
        destination: {
            type: 'register',
            destination: '$a0',
        },
        currentTemporary: firstTemporary,
        globalDeclarations,
        stringLiterals,
    })));

    // Create space for spilled tempraries
    const numSpilledTemporaries = program.temporaryCount - 10
    const makeSpillSpaceCode = numSpilledTemporaries > 0 ? [
        `# Make spill space for main program`,
        `addiu $sp, $sp, -${numSpilledTemporaries * 4}`,
    ] : [];
    const removeSpillSpaceCode = numSpilledTemporaries > 0 ? [
        `# Clean spill space for main program`,
        `addiu $sp, $sp, ${numSpilledTemporaries * 4}`,
    ] : [];

    return `
.data
${globalDeclarations.map(name => `${name.name}: .word 0`).join('\n')}
${stringLiterals.map(text => `string_constant_${text}: .asciiz "${text}"`).join('\n')}
zero_memory_malloc_error: .asciiz "Zero memory requested! Exiting."
sbrk_failed: .asciiz "Memory allocation failed! Exiting."

# First block pointer. Block: size, next, free
first_block: .word 0

.text
${lengthRuntimeFunction()}
${stringEqualityRuntimeFunction()}
${myMallocRuntimeFunction()}

${mipsFunctions.join('\n')}
main:
${makeSpillSpaceCode.join('\n')}
${mipsProgram.join('\n')}
${removeSpillSpaceCode.join('\n')}
# print "exit code" and exit
li $v0, 1
syscall
li $v0, 10
syscall`;
}

const execute = async (path: string): Promise<ExecutionResult> => {
    try {
        const result = await exec(`spim -file ${path}`);
        if (result.stderr !== '') {
            return { error: `Spim error: ${result.stderr}` };
        }
        const lines = result.stdout.split('\n');
        const mipsExitCode = parseInt(lines[lines.length - 1]);
        return {
            exitCode: mipsExitCode,
            stdout: result.stdout,
        };
    } catch (e) {
        return {
            error: `Exception: ${e.message}`
        };
    }
};

const debugWithQtSpim = async path => {
    await exec(`${__dirname}/../../QtSpim.app/Contents/MacOS/QtSpim ${path}`);
};

export default {
    name: 'mips',
    toExectuable,
    execute,
    debug: debugWithQtSpim,
}
