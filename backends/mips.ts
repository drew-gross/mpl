import { exec } from 'child-process-promise';
import flatten from '../util/list/flatten.js';
import { VariableDeclaration, BackendInputs, ExecutionResult } from '../api.js';
import * as Ast from '../ast.js';
import debug from '../util/debug.js';

// 's' registers are used for the args, starting as 0. Spill recovery shall start at the last (7)
const argument1 = '$s0';
const argument2 = '$s1';
const argument3 = '$s2';
const syscallArg1 = '$a0';
const syscallArg2 = '$a1';
const syscallResult = '$v0';
const syscallSelect = '$v0';
const functionResult = '$a0';

const storeLiteralMips = ({ type, destination, spOffset }, value) => {
    if (type == undefined) debug();
    switch (type) {
        case 'register': return `li ${destination}, ${value}`;
        case 'memory': return [
            `li $s7, ${value}`,
            `sw $s7, -${spOffset}($sp)`
        ].join('\n');
        default: throw debug();
    }
}

const subtractMips = ({ type, destination }, left, right) => {
    switch (type) {
        case 'register': return `sub ${destination}, ${left.destination}, ${right.destination}`;
        default: throw debug();
    }
}

const moveMipsDeprecated = ({ type, destination }, source) => {
    switch (type) {
        case 'register': return move({ to: destination, from: source });
        default: throw debug();
    }
}

const moveMips = ({ to, from }: { to: StorageSpec, from: string }) => {
    switch (to.type) {
        case 'register': return move({ to: to.destination, from });
        default: throw debug();
    }
}

const loadAddressOfGlobal = ({ type, destination, spOffset }, value) => {
    switch (type) {
        case 'register': return `la ${destination}, ${value}`;
        default: throw debug();
    }
}

const loadGlobalMips = ({ type, destination, spOffset }, value) => {
    switch (type) {
        case 'register': return `lw ${destination}, ${value}`;
        default: throw debug();
    }
}

const move = ({ from, to }: { from: string, to: string }) => `move ${to}, ${from}`;
const add = ({ l, r, to }: { l: string, r: string, to: string }) => `add ${to}, ${l}, ${r}`;

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
const storageSpecToString = (spec: StorageSpec): string => {
    switch (spec.type) {
        case 'register': return spec.destination;
        case 'memory': return `$sp-${spec.spOffset}`;
    }
}

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
    destination: StorageSpec,
    currentTemporary: StorageSpec,
    globalDeclarations: VariableDeclaration[],
    stringLiterals: any,
};

const astToMips = (input: AstToMipsOptions) => {
    const {
        ast,
        registerAssignment,
        destination,
        currentTemporary,
        globalDeclarations,
        stringLiterals,
    } = input;
    const recurse = newInput => astToMips({ ...input, ...newInput });
    if (!ast) debug();
    switch (ast.kind) {
        case 'returnStatement': return [
            `# evaluate expression of return statement, put in ${functionResult}`,
            ...recurse({
                ast: ast.expression,
                destination: {
                    type: 'register',
                    destination: functionResult,
                },
            }),
        ];
        case 'number': return [storeLiteralMips(destination as any, ast.value)];
        case 'booleanLiteral': return [storeLiteralMips(destination as any, ast.value ? '1' : '0')];
        case 'product': {
            const leftSideDestination = currentTemporary;
            const rightSideDestination = destination;
            const subExpressionTemporary = nextTemporary(currentTemporary);

            const storeLeftInstructions = recurse({
                ast: ast.lhs,
                destination: leftSideDestination,
                currentTemporary: subExpressionTemporary,
            });
            const storeRightInstructions = recurse({
                ast: ast.rhs,
                destination: rightSideDestination,
                currentTemporary: subExpressionTemporary,
            });
            return [
                `# Store left side of product in temporary (${storageSpecToString(leftSideDestination)})`,
                ...storeLeftInstructions,
                `# Store right side of product in destination (${storageSpecToString(rightSideDestination)})`,
                ...storeRightInstructions,
                `# Evaluate product`,
                multiplyMips(destination, leftSideDestination, rightSideDestination),
            ];
        }
        case 'subtraction': {
            const leftSideDestination = currentTemporary;
            if (leftSideDestination.type !== 'register') throw debug();
            const rightSideDestination = destination;
            if (rightSideDestination.type !== 'register') throw debug();
            const subExpressionTemporary = nextTemporary(currentTemporary);

            const storeLeftInstructions = recurse({
                ast: ast.lhs,
                destination: leftSideDestination,
                currentTemporary: subExpressionTemporary,
            });
            const storeRightInstructions = recurse({
                ast: ast.rhs,
                destination: rightSideDestination,
                currentTemporary: subExpressionTemporary,
            });
            return [
                `# Store left side in temporary (${leftSideDestination.destination})`,
                ...storeLeftInstructions,
                `# Store right side in destination (${rightSideDestination.destination})`,
                ...storeRightInstructions,
                `# Evaluate subtraction`,
                subtractMips(destination as any, leftSideDestination, rightSideDestination),
            ];
        }
        case 'statement': return flatten(ast.children.map(child => recurse({
            ast: child,
            destination: '(TODO: READ FROM REGISTER ASSIGNMENT)',
        })));
        case 'functionLiteral': {
            if (destination.type !== 'register') throw debug(); // TODO: Figure out how to guarantee this doesn't happen
            return [
                `# Loading function into register`,
                `la ${destination.destination}, ${ast.deanonymizedName}`
            ];
        }
        case 'callExpression': {
            if (currentTemporary.type !== 'register') throw debug(); // TODO: Figure out how to guarantee this doesn't happen
            if (destination.type !== 'register') throw debug();
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
                ...recurse({
                    ast: ast.argument,
                    destination: { type: 'register', destination: argument1 },
                    currentTemporary: nextTemporary(currentTemporary),
                }),
                `# call ${name}`,
                ...callInstructions,
                `# move result from ${functionResult} into destination`,
                moveMipsDeprecated(destination, functionResult),
            ];
        }
        case 'typedAssignment': {
            const lhs = ast.destination;
            if (globalDeclarations.some(declaration => declaration.name === lhs)) {
                const rhs = recurse({ ast: ast.expression, destination: currentTemporary });
                const declaration = globalDeclarations.find(declaration => declaration.name === lhs);
                if (!declaration) throw debug();
                if (currentTemporary.type !== 'register') throw debug();
                switch (declaration.type.name) {
                    case 'Function':
                        return [
                            `# Put function pointer into temporary`,
                            ...rhs,
                            `# Put function pointer into global`,
                            `sw ${currentTemporary.destination}, ${lhs}`,
                        ];
                    case 'Integer':
                        return [
                            `# Put integer pointer into temporary`,
                            ...rhs,
                            `# Store into global`,
                            `sw ${currentTemporary.destination}, ${lhs}`,
                        ];
                    case 'String':
                        return [
                            `# Put string pointer into temporary`,
                            ...rhs,
                            `# Get string length`,
                            move({ to: argument1, from: currentTemporary.destination }),
                            `jal length`,
                            `# add one for null terminator`,
                            `addiu ${functionResult}, ${functionResult}, 1`,
                            `# Allocate that much space`,
                            move({ to: argument1, from: functionResult }),
                            `jal my_malloc`,
                            `# copy string into allocated space`,
                            move({ to: argument1, from: currentTemporary.destination }),
                            move({ to: argument2, from: functionResult }),
                            `jal string_copy`,
                            `# Store into global`,
                            `sw ${functionResult}, ${lhs}`,
                        ];
                    default: throw debug();
                }
            } else if (lhs in registerAssignment) {
                return [
                    `# Run rhs of assignment and store to ${lhs} (${registerAssignment[lhs].destination})`,
                    ...recurse({
                        ast: ast.expression,
                        // TODO: Allow spilling of variables
                        destination: {
                            type: 'register',
                            destination: `${registerAssignment[lhs].destination}`,
                        },
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
                if (!declaration) throw debug();
                return [
                    `# Move from global ${identifierName} into destination (${(destination as any).destination || (destination as any).spOffset})`,
                    loadGlobalMips(destination as any, identifierName),
                ];
            }
            const identifierRegister = registerAssignment[identifierName].destination;
            return [
                `# Move from ${identifierName} (${identifierRegister}) into destination (${(destination as any).destination || (destination as any).spOffset})`,
                moveMipsDeprecated(destination as any, identifierRegister),
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
                ...recurse({
                    ast: ast.condition,
                    destination: booleanTemporary,
                    currentTemporary: subExpressionTemporary,
                }),
                `# Go to false branch if zero`,
                mipsBranchIfEqual(booleanTemporary, { type: 'register', destination: '$0' }, `L${falseBranchLabel}`),
                `# Execute true branch`,
                ...recurse({ ast: ast.ifTrue, currentTemporary: subExpressionTemporary }),
                `# Jump to end of ternary`,
                `b L${endOfTernaryLabel}`,
                `L${falseBranchLabel}:`,
                `# Execute false branch`,
                ...recurse({ ast: ast.ifFalse, currentTemporary: subExpressionTemporary }),
                `# End of ternary label`,
                `L${endOfTernaryLabel}:`,
            ];
        }
        case 'equality': {
            const leftSideDestination = currentTemporary;
            const rightSideDestination = destination;
            const subExpressionTemporary = nextTemporary(currentTemporary);
            const storeLeftInstructions = recurse({
                ast: ast.lhs,
                destination: leftSideDestination,
                currentTemporary: subExpressionTemporary,
            });
            const storeRightInstructions = recurse({
                ast: ast.rhs,
                destination: rightSideDestination,
                currentTemporary: subExpressionTemporary,
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
                storeLiteralMips(destination as any, '0'),
                `# And goto exit`,
                `b L${endOfConditionLabel}`,
                `L${equalLabel}:`,
                storeLiteralMips(destination as any, '1'),
                `L${endOfConditionLabel}:`,
            ];
        }
        case 'stringEquality': {
            // Put left in s0 and right in s1 for passing to string equality function
            const storeLeftInstructions = recurse({
                ast: ast.lhs,
                destination: {
                    type: 'register',
                    destination: argument1,
                },
            });
            const storeRightInstructions = recurse({
                ast: ast.rhs,
                destination: {
                    type: 'register',
                    destination: argument2,
                },
            });
            return [
                `# Store left side in s0`,
                ...storeLeftInstructions,
                `# Store right side in s1`,
                ...storeRightInstructions,
                `# Call stringEquality`,
                `jal stringEquality`,
                `# Return value in ${functionResult}. Move to destination`,
                moveMipsDeprecated(destination as any, functionResult),
            ];
        }
        case 'stringLiteral': {
            return [
                `# Load string literal address into register`,
                loadAddressOfGlobal(destination as any, `string_constant_${ast.value}`),
            ];
        }
        case 'concatenation': {
            if (destination.type !== 'register') throw debug();
            const leftSideDestination = currentTemporary;
            if (leftSideDestination.type !== 'register') throw debug();
            const rightSideDestination = nextTemporary(leftSideDestination);
            if (rightSideDestination.type !== 'register') throw debug();
            const subExpressionTemporary = nextTemporary(rightSideDestination);
            const newStringLengthTemporary = nextTemporary(subExpressionTemporary);
            if (newStringLengthTemporary.type !== 'register') throw debug();
            const mallocResultTemporary = newStringLengthTemporary; // Don't need length after malloc is done

            const storeLeftInstructions = recurse({
                ast: ast.lhs,
                destination: leftSideDestination,
                currentTemporary: subExpressionTemporary,
            });
            const storeRightInstructions = recurse({
                ast: ast.rhs,
                destination: rightSideDestination,
                currentTemporary: subExpressionTemporary,
            });
            return [
                `# Create a temporary to store new string length. Start with 1 for null terminator.`,
                `li ${newStringLengthTemporary.destination}, 1`,
                `# Compute lhs`,
                ...storeLeftInstructions,
                `# Compute rhs`,
                ...storeRightInstructions,
                `# Compute the length of lhs and add it to length temporary`,
                move({ from: leftSideDestination.destination, to: argument1 }),
                `jal length`,
                add({
                    l: functionResult,
                    r: newStringLengthTemporary.destination,
                    to: newStringLengthTemporary.destination,
                }),
                `# Compute the length of rhs and add it to length temporary`,
                move({ from: rightSideDestination.destination, to: argument1 }),
                `jal length`,
                add({
                    l: functionResult,
                    r: newStringLengthTemporary.destination,
                    to: newStringLengthTemporary.destination,
                 }),
                `# Malloc that much space`,
                move({ from: newStringLengthTemporary.destination, to: argument1 }),
                `jal my_malloc`,
                `# Save result`,
                move({ from: functionResult, to: mallocResultTemporary.destination }),
                `# Concatenate the strings and write to malloced space`,
                move({ from: leftSideDestination.destination, to: argument1 }),
                move({ from: rightSideDestination.destination, to: argument2 }),
                move({ from: mallocResultTemporary.destination, to: argument3 }),
                `jal string_concatenate`,
                `# Move malloced pointer to final destination`,
                move({ from: mallocResultTemporary.destination, to: destination.destination }),
            ]
        }
        default:
            debug();

    }
}

const assignMipsRegisters = (variables: VariableDeclaration[]): { registerAssignment: any, firstTemporary: StorageSpec } => {
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
            destination: functionResult as any, // TODO: Not sure how this works. Maybe it doesn't.
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
    const currentChar = '$t1';
    return `length:
    ${saveRegistersCode(1).join('\n')}

    # Set length count to 0
    li ${functionResult}, 0
    length_loop:
    # Load char into temporary
    lb ${currentChar}, (${argument1})
    # If char is null, end of string. Return count.
    beq ${currentChar}, 0, length_return
    # Else bump pointer and count and return to start of loop
    addiu ${functionResult}, ${functionResult}, 1
    addiu ${argument1}, ${argument1}, 1
    b length_loop

    length_return:
    ${restoreRegistersCode(1).join('\n')}
    jr $ra`;
}

const stringEqualityRuntimeFunction = () => {
    const leftByte = '$t1';
    const rightByte = '$t2';
    return `stringEquality:
    ${saveRegistersCode(2).join('\n')}

    # Assume equal. Write 1 to $a0. Overwrite if difference found.
    li ${functionResult}, 1

    # (string*, string*) -> bool
    stringEquality_loop:
    # load current chars into temporaries
    lb ${leftByte}, (${argument1})
    lb ${rightByte}, (${argument2})
    # Inequal: return false
    bne ${leftByte}, ${rightByte}, stringEquality_return_false
    # Now we know both sides are equal. If they equal null, string is over.
    # Return true. We already set ${functionResult} to 1, so just goto end.
    beq ${leftByte}, 0, stringEquality_return
    # Otherwise, bump pointers and check next char
    addiu ${argument1}, 1
    addiu ${argument2}, 1
    b stringEquality_loop

    stringEquality_return_false:
    li ${functionResult}, 0
    stringEquality_return:
    ${restoreRegistersCode(2).join('\n')}
    jr $ra`;
}

const stringCopyRuntimeFunction = () => {
    const currentChar = '$t1';
    return `string_copy:
    ${saveRegistersCode(1).join('\n')}
    # load byte from input
    string_copy_loop:
    lb ${currentChar}, (${argument1})
    # write it to argument 2
    sb ${currentChar}, (${argument2})
    # If it was the null terminator, exit
    beq ${currentChar}, $0, string_copy_return
    # Else, bump the pointers so we copy the next char, and copy copy the next char
    addiu ${argument1}, ${argument1}, 1
    addiu ${argument2}, ${argument2}, 1
    b string_copy_loop
    string_copy_return:
    ${restoreRegistersCode(1).join('\n')}
    jr $ra`;
}

const stringConcatenateRuntimeFunction = () => {
    const left = argument1;
    const right = argument2;
    const out = argument3;
    const currentChar = '$t1';
    return `string_concatenate:
    ${saveRegistersCode(1).join('\n')}
    # Load byte from left
    write_left_loop:
    lb ${currentChar}, (${left}),
    # If null, start copying from right
    beq ${currentChar}, $0, copy_from_right
    # Else, write to out, bump pointers, and loop
    sb ${currentChar}, (${out})
    addiu ${left}, ${left}, 1
    addiu ${out}, ${out}, 1
    b write_left_loop
    copy_from_right:
    lb ${currentChar}, (${right})
    # always write (to get null terminator)
    sb ${currentChar}, (${out})
    # if we just wrote a null terminator, we are done
    beq ${currentChar}, $0, concatenate_return
    # Else bump pointers and loop
    addiu ${right}, ${right}, 1
    addiu ${out}, ${out}, 1,
    b copy_from_right
    concatenate_return:
    ${restoreRegistersCode(1).join('\n')}
    jr $ra`;
}

const bytesInWord = 4;

const myMallocRuntimeFunction = () => {
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
    lw ${scratch}, ${2 * bytesInWord}(${currentBlockPointer})
    beq ${scratch}, 0, advance_pointers
    # current block not large enough, try next
    lw ${scratch}, 0(${currentBlockPointer})
    bgt ${scratch}, ${argument1}, advance_pointers
    # We found a large enough block! Hooray!
    b find_large_enough_free_block_loop_exit

    advance_pointers:
    ${move({ to: previousBlockPointer, from: currentBlockPointer })}
    lw ${currentBlockPointer}, ${1 * bytesInWord}(${currentBlockPointer})
    b find_large_enough_free_block_loop

    find_large_enough_free_block_loop_exit:
    beq ${currentBlockPointer}, 0, sbrk_more_space

    # Found a reusable block, mark it as not free
    sw $0, ${2 * bytesInWord}(${currentBlockPointer})
    # add 3 words to get actual space
    ${move({ to: functionResult, from: currentBlockPointer })}
    addiu ${functionResult}, ${3 * bytesInWord}
    b my_malloc_return

    sbrk_more_space:
    ${move({ to: syscallArg1, from: argument1 })}
    # Include space for management block
    addiu ${syscallArg1}, ${3 * bytesInWord}
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
    sw ${syscallResult}, ${1 * bytesInWord}(${previousBlockPointer})

    set_up_new_space:
    # Save size to new block
    sw ${argument1}, 0(${syscallResult})
    # Save next pointer = nullptr
    sw $0, ${1 * bytesInWord}(${syscallResult})
    # Not free as we are about to use it
    sw $0, ${2 * bytesInWord}(${syscallResult})
    ${move({ to: functionResult, from: syscallResult })}
    # add 3 words to get actual space
    addiu ${functionResult}, ${3 * bytesInWord}

    my_malloc_return:
    ${restoreRegistersCode(3).join('\n')}
    jr $ra
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
${stringCopyRuntimeFunction()}
${myMallocRuntimeFunction()}
${stringConcatenateRuntimeFunction()}

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
