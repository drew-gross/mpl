import { exec } from 'child-process-promise';
import { isEqual } from 'lodash';
import flatten from '../util/list/flatten.js';
import { VariableDeclaration, BackendInputs, ExecutionResult, Function, StringLiteralData } from '../api.js';
import * as Ast from '../ast.js';
import debug from '../util/debug.js';
import {
    CompiledProgram,
    BackendOptions,
    compileExpression,
    StorageSpec,
    RegisterAssignment,
    storageSpecToString,
} from '../backend-utils.js';
import {
    astToRegisterTransferLanguage,
    PureRegisterTransferLanguageExpression,
    RegisterTransferLanguageExpression,
} from './registerTransferLanguage.js';
import { errors } from '../runtime-strings.js';
import { builtinFunctions } from '../frontend.js';
import join from '../util/join.js';

// 's' registers are used for the args, starting as 0. Spill recovery shall start at the last (7)
const argument1 = '$s0';
const argument2 = '$s1';
const argument3 = '$s2';
const syscallArg1 = '$a0';
const syscallArg2 = '$a1';
const syscallResult = '$v0';
const syscallSelect = '$v0';
const functionResult = '$a0';

const storeLiteralMips = (destination: StorageSpec, value) => {
    if (destination.type == undefined) debug();
    switch (destination.type) {
        case 'register':
            return `li ${destination.destination}, ${value}`;
        case 'memory':
            return [`li $s7, ${value}`, `sw $s7, -${destination.spOffset}($sp)`].join('\n');
        default:
            throw debug();
    }
};

const add = ({ l, r, to }: { l: string; r: string; to: string }) => `add ${to}, ${l}, ${r}`;

const multiplyMips = (destination, left, right) => {
    let leftRegister = left.destination;
    let loadSpilled: any = [];
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
};

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
        };
    } else {
        return debug();
    }
};

let labelId = 0;

const astToMips = (input: BackendOptions): CompiledProgram => {
    const { ast, registerAssignment, destination, currentTemporary, globalDeclarations, stringLiterals } = input;
    if (isEqual(currentTemporary, destination)) throw debug(); // Sanity check to make sure caller remembered to provide a new temporary
    const recurse = newInput => astToMips({ ...input, ...newInput });
    const makeLabel = (name: string) => {
        const result = `${name}${labelId}`;
        labelId++;
        return result;
    };
    if (!ast) debug();
    switch (ast.kind) {
        case 'number':
        case 'returnStatement':
        case 'subtraction':
        case 'ternary':
        case 'booleanLiteral':
        case 'functionLiteral':
        case 'callExpression':
            return astToRegisterTransferLanguage(
                input,
                {
                    argument1: argument1,
                    argument2: argument2,
                    argument3: argument3,
                    functionResult: functionResult,
                },
                nextTemporary,
                makeLabel,
                recurse
            );
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
            return compileExpression([storeLeftInstructions, storeRightInstructions], ([storeLeft, storeRight]) => [
                `# Store left side of product in temporary (${storageSpecToString(leftSideDestination)})`,
                ...storeLeft,
                `# Store right side of product in destination (${storageSpecToString(rightSideDestination)})`,
                ...storeRight,
                `# Evaluate product`,
                multiplyMips(destination, leftSideDestination, rightSideDestination),
            ]);
        }
        case 'addition': {
            if (destination.type !== 'register') throw debug();
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
            return compileExpression([storeLeftInstructions, storeRightInstructions], ([storeLeft, storeRight]) => [
                `# Store left side in temporary (${leftSideDestination.destination})`,
                ...storeLeft,
                `# Store right side in destination (${rightSideDestination.destination})`,
                ...storeRight,
                `# Evaluate addition`,
                add({
                    l: leftSideDestination.destination,
                    r: rightSideDestination.destination,
                    to: destination.destination,
                }),
            ]);
        }
        case 'typedDeclarationAssignment': {
            const lhs = ast.destination;
            if (globalDeclarations.some(declaration => declaration.name === lhs)) {
                const subExpressionTemporary = nextTemporary(currentTemporary);
                const rhs = recurse({
                    ast: ast.expression,
                    destination: currentTemporary,
                    currentTemporary: subExpressionTemporary,
                });
                const declaration = globalDeclarations.find(declaration => declaration.name === lhs);
                if (!declaration) throw debug();
                if (currentTemporary.type !== 'register') throw debug();
                switch (declaration.type.name) {
                    case 'Function':
                    case 'Integer':
                        return compileExpression([rhs], ([e1]) => [
                            `# Put ${declaration.type.name} into temporary`,
                            ...e1,
                            `# Put ${declaration.type.name} into global`,
                            `sw ${currentTemporary.destination}, ${lhs}`,
                        ]);
                    case 'String':
                        return compileExpression([rhs], ([e1]) => [
                            ...e1,
                            {
                                kind: 'move',
                                to: argument1,
                                from: currentTemporary.destination,
                                why: 'Put string pointer into temporary',
                            },
                            { kind: 'call', function: 'length', why: 'Get string length' },
                            `# add one for null terminator`,
                            `addiu ${functionResult}, ${functionResult}, 1`,
                            { kind: 'move', to: argument1, from: functionResult, why: 'Move length to argument1' },
                            { kind: 'call', function: 'my_malloc', why: 'Allocate that much space' },
                            {
                                kind: 'move',
                                to: argument1,
                                from: currentTemporary.destination,
                                why: 'Move destination to argument 1',
                            },
                            {
                                kind: 'move',
                                to: argument2,
                                from: functionResult,
                                why: 'Move output pointer to argument 2',
                            },
                            { kind: 'call', function: 'string_copy', why: 'Copy string into allocated space ' },
                            `# Store into global`,
                            `sw ${functionResult}, ${lhs}`,
                        ]);
                    default:
                        throw debug();
                }
            } else if (lhs in registerAssignment) {
                return recurse({
                    ast: ast.expression,
                    // TODO: Allow spilling of variables
                    destination: {
                        type: 'register',
                        destination: `${(registerAssignment[lhs] as any).destination}`,
                    },
                });
            } else {
                throw debug();
            }
        }
        case 'reassignment': {
            const lhs = ast.destination;
            if (globalDeclarations.some(declaration => declaration.name === lhs)) {
                const subExpressionTemporary = nextTemporary(currentTemporary);
                const savedPointerForFreeing = subExpressionTemporary;
                const rhs: CompiledProgram = recurse({
                    ast: ast.expression,
                    destination: currentTemporary,
                    currentTemporary: nextTemporary(subExpressionTemporary),
                });
                const declaration = globalDeclarations.find(declaration => declaration.name === lhs);
                if (!declaration) throw debug();
                if (currentTemporary.type !== 'register') throw debug();
                switch (declaration.type.name) {
                    case 'Function':
                    case 'Integer':
                        return compileExpression([rhs], ([e1]) => [
                            `# Put ${declaration.type.name} into temporary`,
                            ...e1,
                            `# Store into global`,
                            `sw ${currentTemporary.destination}, ${lhs}`,
                        ]);
                    case 'String':
                        if (!('destination' in savedPointerForFreeing)) throw debug();
                        const prepAndCleanup = {
                            prepare: [
                                `lw ${
                                    savedPointerForFreeing.destination
                                }, ${lhs} # Save global for freeing after assignment`,
                            ],
                            execute: [],
                            cleanup: [
                                {
                                    kind: 'move',
                                    from: savedPointerForFreeing.destination,
                                    to: argument1,
                                    why: 'Move global to argument 1 of free',
                                },
                                { kind: 'call', function: 'my_free', why: 'Free string that is no longer accessible' },
                            ] as RegisterTransferLanguageExpression[],
                        };
                        return compileExpression([rhs, prepAndCleanup], ([e1, _]) => [
                            ...e1,
                            {
                                kind: 'move',
                                from: currentTemporary.destination,
                                to: argument1,
                                why: 'Move from temporary to argument 1',
                            },
                            { kind: 'call', function: 'length', why: 'Get length of new string' },
                            {
                                kind: 'move',
                                from: functionResult,
                                to: argument1,
                                why: 'Move length of new string to argument of malloc',
                            },
                            { kind: 'call', function: 'my_malloc', why: 'Allocate space for new string' },
                            `sw ${functionResult}, ${lhs} # Store location of allocated memory to global`,
                            {
                                kind: 'move',
                                from: functionResult,
                                to: argument2,
                                why: 'Move output pointer to argument 2 of string_copy',
                            },
                            {
                                kind: 'move',
                                from: currentTemporary.destination,
                                to: argument1,
                                why: 'move destination to argument 1 of string_copy',
                            },
                            { kind: 'call', function: 'string_copy', why: 'Copy new string to destination' },
                        ]);
                    default:
                        throw debug();
                }
            } else if (lhs in registerAssignment) {
                return recurse({
                    ast: ast.expression,
                    // TODO: Allow spilling of variables
                    destination: {
                        type: 'register',
                        destination: `${(registerAssignment[lhs] as any).destination}`,
                    },
                });
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
                return compileExpression([], ([]) => [
                    {
                        kind: 'loadGlobal',
                        to: destination,
                        from: identifierName,
                        why: `Load ${identifierName} from global into register`,
                    },
                ]);
            }
            const identifierRegister = (registerAssignment[identifierName] as any).destination;
            return compileExpression([], ([]) => [
                {
                    kind: 'move',
                    from: identifierRegister,
                    to: (destination as any).destination,
                    why: `Move from ${identifierName} (${identifierRegister}) into destination (${
                        (destination as any).destination
                    }`,
                },
            ]);
        }
        case 'equality': {
            if (ast.type.name == 'String') {
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
                return compileExpression([storeLeftInstructions, storeRightInstructions], ([e1, e2]) => [
                    `# Store left side in s0`,
                    ...e1,
                    `# Store right side in s1`,
                    ...e2,
                    { kind: 'call', function: 'stringEquality', why: 'Call stringEquality' },
                    {
                        kind: 'move',
                        from: functionResult,
                        to: (destination as any).destination,
                        why: `Return value in ${functionResult}. Move to destination`,
                    },
                ]);
            } else {
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

                const equalLabel = `${labelId}`;
                labelId++;
                const endOfConditionLabel = labelId;
                labelId++;

                let jumpIfEqualInstructions = [];

                return compileExpression([storeLeftInstructions, storeRightInstructions], ([storeLeft, storeRight]) => [
                    `# Store left side of equality in temporary`,
                    ...storeLeft,
                    `# Store right side of equality in temporary`,
                    ...storeRight,
                    {
                        kind: 'gotoIfEqual',
                        lhs: leftSideDestination,
                        rhs: rightSideDestination,
                        label: equalLabel,
                        why: 'Goto set 1 if equal',
                    },
                    `# Not equal, set 0`,
                    storeLiteralMips(destination as any, '0'),
                    `# And goto exit`,
                    `b L${endOfConditionLabel}`,
                    `L${equalLabel}:`,
                    storeLiteralMips(destination as any, '1'),
                    `L${endOfConditionLabel}:`,
                ]);
            }
        }
        case 'stringLiteral': {
            const stringLiteralData = stringLiterals.find(({ value }) => value == ast.value);
            if (!stringLiteralData) throw debug();
            return compileExpression([], ([]) => [
                {
                    kind: 'loadSymbolAddress',
                    symbolName: stringLiteralName(stringLiteralData),
                    to: destination,
                    why: 'Load string literal address into register',
                },
            ]);
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
            const cleanup: CompiledProgram = {
                prepare: [],
                execute: [],
                cleanup: [
                    {
                        kind: 'move',
                        from: mallocResultTemporary.destination,
                        to: argument1,
                        why: 'Move pointer to new string to argument1',
                    },
                    // TODO: maybe not valid? This destination may have been reused for something else by the time we get to cleanup
                    { kind: 'call', function: 'my_free', why: 'Freeing temporary from concat' },
                ],
            };
            return compileExpression([storeLeftInstructions, storeRightInstructions, cleanup], ([e1, e2, _]) => [
                `# Create a temporary to store new string length. Start with 1 for null terminator.`,
                `li ${newStringLengthTemporary.destination}, 1`,
                `# Compute lhs`,
                ...e1,
                `# Compute rhs`,
                ...e2,
                { kind: 'move', from: leftSideDestination.destination, to: argument1, why: 'Move lhs to argument1' },
                { kind: 'call', function: 'length', why: 'Compute the length of lhs and add it to length temporary' },
                add({
                    l: functionResult,
                    r: newStringLengthTemporary.destination,
                    to: newStringLengthTemporary.destination,
                }),
                { kind: 'move', from: rightSideDestination.destination, to: argument1, why: 'Move rhs to argument1' },
                { kind: 'call', function: 'length', why: 'Compute the length of rhs and add it to length temporary' },
                add({
                    l: functionResult,
                    r: newStringLengthTemporary.destination,
                    to: newStringLengthTemporary.destination,
                }),
                {
                    kind: 'move',
                    from: newStringLengthTemporary.destination,
                    to: argument1,
                    why: 'Move new string length to argument1',
                },
                { kind: 'call', function: 'my_malloc', why: 'Malloc that much space' },
                {
                    kind: 'move',
                    from: functionResult,
                    to: mallocResultTemporary.destination,
                    why: 'Move malloc result to temporary',
                },
                { kind: 'move', from: leftSideDestination.destination, to: argument1, why: 'Move lhs to argument1' },
                { kind: 'move', from: rightSideDestination.destination, to: argument2, why: 'Move rhs to argument2' },
                {
                    kind: 'move',
                    from: mallocResultTemporary.destination,
                    to: argument3,
                    why: 'Move destintion to argument3',
                },
                {
                    kind: 'call',
                    function: 'string_concatenate',
                    why: 'Concatenate the strings and write to malloced space',
                },
                {
                    kind: 'move',
                    from: mallocResultTemporary.destination,
                    to: destination.destination,
                    why: 'Move new string pointer to final destination',
                },
            ]);
        }
        default:
            throw debug();
    }
};

const assignMipsRegisters = (
    variables: VariableDeclaration[]
): { registerAssignment: RegisterAssignment; firstTemporary: StorageSpec } => {
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
    let result = [`# Always store return address`, `sw $ra, ($sp)`, `addiu $sp, $sp, -4`];
    while (numRegisters > 0) {
        result.push(`sw $t${numRegisters}, ($sp)`);
        result.push(`addiu $sp, $sp, -4`);
        numRegisters--;
    }
    return result;
};

const restoreRegistersCode = (numRegisters: number): string[] => {
    let result = [`lw $ra, ($sp)`, `addiu $sp, $sp, 4`, `# Always restore return address`];
    while (numRegisters > 0) {
        result.push(`lw $t${numRegisters}, ($sp)`);
        result.push(`addiu $sp, $sp, 4`);
        numRegisters--;
    }
    return result.reverse();
};

const registerTransferExpressionToMips = (rtx: RegisterTransferLanguageExpression): string => {
    if (typeof rtx == 'string') return rtx;
    switch (rtx.kind) {
        case 'move':
            return `move ${rtx.to}, ${rtx.from} # ${rtx.why}`;
        case 'loadImmediate':
            return storeLiteralMips(rtx.destination as any, rtx.value);
        case 'return':
            if (rtx.source.type !== 'register') throw debug();
            return `move ${functionResult}, ${rtx.source.destination} # ${rtx.why}`;
        case 'subtract':
            if (rtx.lhs.type !== 'register') throw debug();
            if (rtx.rhs.type !== 'register') throw debug();
            if (rtx.destination.type !== 'register') throw debug();
            return `sub ${rtx.destination.destination}, ${rtx.lhs.destination}, ${rtx.rhs.destination}`;
        case 'label':
            return `L${rtx.name}: # ${rtx.why}`;
        case 'goto':
            return `b L${rtx.label}`;
        case 'gotoIfEqual':
            if (rtx.lhs.type !== 'register' || rtx.rhs.type !== 'register') throw debug();
            return `beq ${rtx.lhs.destination}, ${rtx.rhs.destination}, L${rtx.label}`;
        case 'loadSymbolAddress':
            if (rtx.to.type !== 'register') throw debug();
            return `la ${rtx.to.destination}, ${rtx.symbolName} # ${rtx.why}`;
        case 'loadGlobal':
            if (rtx.to.type !== 'register') throw debug();
            return `lw ${rtx.to.destination}, ${rtx.from}`;
        case 'call':
            return `jal ${rtx.function} # ${rtx.why}`;
        default:
            throw debug();
    }
};

const constructFunction = (
    f: Function,
    globalDeclarations,
    stringLiterals,
    argumentRegisters
): RegisterTransferLanguageExpression[] => {
    // Statments are either assign or return right now, so we need one register for each statement, minus the return statement.
    const scratchRegisterCount = f.temporaryCount + f.statements.length - 1;

    if (f.parameters.length > 3) throw debug(); // Don't want to deal with this yet.
    if (argumentRegisters.length < 3) throw debug();
    const registerAssignment: any = {};
    f.parameters.forEach((parameter, index) => {
        registerAssignment[parameter.name] = {
            type: 'register',
            destination: argumentRegisters[index],
        };
    });

    let currentTemporary: StorageSpec = {
        type: 'register',
        destination: '$t1',
    };

    f.statements.forEach(statement => {
        if (statement.kind === 'typedDeclarationAssignment') {
            registerAssignment[statement.destination] = currentTemporary;
            currentTemporary = nextTemporary(currentTemporary);
        }
    });

    const mipsCode = flatten(
        f.statements.map(statement => {
            const compiledProgram = astToMips({
                ast: statement,
                registerAssignment,
                destination: functionResult as any, // TODO: Not sure how this works. Maybe it doesn't.
                currentTemporary,
                globalDeclarations,
                stringLiterals,
            });
            const freeLocals = f.variables
                // TODO: Make a better memory model for frees.
                .filter(s => s.location === 'Stack')
                .filter(s => s.type.name == 'String')
                .map(s => {
                    const memoryForVariable: StorageSpec = registerAssignment[s.name];
                    if (memoryForVariable.type !== 'register') throw debug();
                    return [
                        { kind: 'move', from: memoryForVariable.destination, to: argument1 },
                        { kind: 'call', function: 'my_free', why: 'Free Stack String at end of scope' },
                    ];
                });

            return [
                ...compiledProgram.prepare,
                ...compiledProgram.execute,
                ...compiledProgram.cleanup,
                // ...flatten(freeLocals), // TODO: Freeing locals should be necessary...
            ];
        })
    );
    return [
        `${f.name}:`,
        ...saveRegistersCode(scratchRegisterCount),
        ...mipsCode,
        ...restoreRegistersCode(scratchRegisterCount),
        `jr $ra`,
    ];
};

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
};

const printRuntimeFunction = (): RegisterTransferLanguageExpression[] => {
    return [
        `print:`,
        `li ${syscallSelect}, 4`,
        { kind: 'move', to: syscallArg1, from: argument1, why: 'Move print argument to syscall argument' },
        `syscall`,
        { kind: 'move', from: syscallResult, to: functionResult, why: 'Move syscall result to function result' },
        `jr $ra`,
    ];
};

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
};

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
};

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
};

const bytesInWord = 4;

const myMallocRuntimeFunction = (): RegisterTransferLanguageExpression[] => {
    const currentBlockPointer = '$t1';
    const previousBlockPointer = '$t2';
    const scratch = '$t3';
    return [
        `my_malloc:`,
        `${saveRegistersCode(3).join('\n')}`,
        `bne ${argument1}, 0, my_malloc_zero_size_check_passed`,
        `la $a0, ${errors.allocatedZero.name}`,
        `li $v0, 4`,
        `syscall`,
        `li $v0, 10`,
        `syscall`,
        `my_malloc_zero_size_check_passed:`,
        `la ${currentBlockPointer}, first_block`,
        `la ${previousBlockPointer}, 0`,
        `find_large_enough_free_block_loop:`,
        `# no blocks left (will require sbrk)`,
        `beq ${currentBlockPointer}, 0, find_large_enough_free_block_loop_exit`,
        `# current block not free, try next`,
        `lw ${scratch}, ${2 * bytesInWord}(${currentBlockPointer})`,
        `beq ${scratch}, 0, advance_pointers`,
        `# current block not large enough, try next`,
        `lw ${scratch}, 0(${currentBlockPointer})`,
        `bgt ${scratch}, ${argument1}, advance_pointers`,
        `# We found a large enough block! Hooray!`,
        `b find_large_enough_free_block_loop_exit`,
        `advance_pointers:`,
        {
            kind: 'move',
            to: previousBlockPointer,
            from: currentBlockPointer,
            why: 'Advance current block pointer to previous.',
        },
        `lw ${currentBlockPointer}, ${1 * bytesInWord}(${currentBlockPointer})`,
        `b find_large_enough_free_block_loop`,
        `find_large_enough_free_block_loop_exit:`,
        `beq ${currentBlockPointer}, 0, sbrk_more_space`,
        `# Found a reusable block, mark it as not free`,
        `sw $0, ${2 * bytesInWord}(${currentBlockPointer})`,
        { kind: 'move', to: functionResult, from: currentBlockPointer, why: 'Return current block pointer' },
        `# add 3 words to get actual space`,
        `addiu ${functionResult}, ${3 * bytesInWord}`,
        `b my_malloc_return`,
        `sbrk_more_space:`,
        { kind: 'move', to: syscallArg1, from: argument1, why: 'Move amount of space to allocate to sbrk argument' },
        `# Include space for management block`,
        `addiu ${syscallArg1}, ${3 * bytesInWord}`,
        `li ${syscallSelect}, 9`,
        `syscall`,
        `# If sbrk failed, exit`,
        `bne ${syscallResult}, -1, sbrk_exit_check_passed`,
        `la $a0, ${errors.allocationFailed.name}`,
        `li $v0, 4`,
        `syscall`,
        `li $v0, 10`,
        `syscall`,
        `sbrk_exit_check_passed:`,
        `# ${syscallResult} now contains pointer to block. Set up pointer to new block.`,
        {
            kind: 'loadGlobal',
            from: 'first_block',
            to: { type: 'register', destination: scratch },
            why: 'Load first block so we can write to it if necessary',
        },
        `bne ${scratch}, 0, assign_previous`,
        `sw ${syscallResult}, first_block`,
        `b set_up_new_space`,
        `assign_previous:`,
        `beq ${previousBlockPointer}, 0, set_up_new_space`,
        `sw ${syscallResult}, (${previousBlockPointer})`,
        `set_up_new_space:`,
        `# Save size to new block`,
        `sw ${argument1}, 0(${syscallResult})`,
        `# Save next pointer = nullptr`,
        `sw $0, ${1 * bytesInWord}(${syscallResult})`,
        `# Not free as we are about to use it`,
        `sw $0, ${2 * bytesInWord}(${syscallResult})`,
        { kind: 'move', to: functionResult, from: syscallResult, why: 'Return result of sbrk' },
        `# add 3 words to get actual space`,
        `addiu ${functionResult}, ${3 * bytesInWord}`,
        `my_malloc_return:`,
        `${restoreRegistersCode(3).join('\n')}`,
        `jr $ra`,
    ];
};

const myFreeRuntimeFunction = () => {
    const one = '$t1';
    return `
    my_free:
    ${saveRegistersCode(1).join('\n')}
    bne ${argument1}, 0, free_null_check_passed
    la $a0, ${errors.freeNull.name}
    li $v0, 4
    syscall
    li $v0, 10
    syscall
    free_null_check_passed:
    # TODO: merge blocks
    # TODO: check if already free
    li ${one}, 1,
    sw ${one}, ${-1 * bytesInWord}(${argument1}) # free = work before space
    ${restoreRegistersCode(1).join('\n')}
    jr $ra`;
};

const verifyNoLeaks = () => {
    const currentBlockPointer = '$t1';
    const currentData = '$t2';
    return `verify_no_leaks:
    ${saveRegistersCode(2).join('\n')}
    la ${currentBlockPointer}, first_block
    lw ${currentBlockPointer}, (${currentBlockPointer})
    verify_no_leaks_loop:
    beq ${currentBlockPointer}, 0, verify_no_leaks_return
    lw ${currentData}, ${2 * bytesInWord}(${currentBlockPointer})
    bne ${currentData}, 0, verify_no_leaks_advance_pointers
    la $a0, ${errors.leaksDetected.name}
    li $v0, 4
    syscall
    li $v0, 10
    syscall
    verify_no_leaks_advance_pointers:
    lw ${currentBlockPointer}, ${1 * bytesInWord}(${currentBlockPointer})
    b verify_no_leaks_loop
    verify_no_leaks_return:
    ${restoreRegistersCode(2).join('\n')}
    jr $ra`;
};

const stringLiteralName = ({ id, value }: StringLiteralData) =>
    `string_literal_${id}_${value.replace(/[^a-zA-Z]/g, '')}`;
const stringLiteralDeclaration = (literal: StringLiteralData) =>
    `${stringLiteralName(literal)}: .asciiz "${literal.value}"`;

const toExectuable = ({ functions, program, globalDeclarations, stringLiterals }: BackendInputs) => {
    let mipsFunctions = functions.map(f =>
        constructFunction(f, globalDeclarations, stringLiterals, [argument1, argument2, argument3])
    );
    const { registerAssignment, firstTemporary } = assignMipsRegisters(program.variables);
    let mipsProgram = flatten(
        program.statements.map(statement => {
            const compiledProgram = astToMips({
                ast: statement,
                registerAssignment,
                destination: {
                    type: 'register',
                    destination: '$a0',
                },
                currentTemporary: firstTemporary,
                globalDeclarations,
                stringLiterals,
            });

            return [...compiledProgram.prepare, ...compiledProgram.execute, ...compiledProgram.cleanup];
        })
    );

    const freeGlobals: PureRegisterTransferLanguageExpression[] = flatten(
        globalDeclarations.filter(declaration => declaration.type.name === 'String').map(declaration => [
            {
                kind: 'loadGlobal',
                from: declaration.name,
                to: { type: 'register', destination: argument1 },
                why: 'Load global string so we can free it',
            } as PureRegisterTransferLanguageExpression,
            {
                kind: 'call',
                function: 'my_free',
                why: 'Free gloabal string at end of program',
            } as PureRegisterTransferLanguageExpression,
        ])
    );

    // Create space for spilled tempraries
    const numSpilledTemporaries = program.temporaryCount - 10;
    const makeSpillSpaceCode =
        numSpilledTemporaries > 0
            ? [`# Make spill space for main program`, `addiu $sp, $sp, -${numSpilledTemporaries * 4}`]
            : [];
    const removeSpillSpaceCode =
        numSpilledTemporaries > 0
            ? [`# Clean spill space for main program`, `addiu $sp, $sp, ${numSpilledTemporaries * 4}`]
            : [];

    return `
.data
${globalDeclarations.map(name => `${name.name}: .word 0`).join('\n')}
${stringLiterals.map(stringLiteralDeclaration).join('\n')}
${Object.keys(errors)
        .map(key => `${errors[key].name}: .asciiz "${errors[key].value}"`)
        .join('\n')}

# First block pointer. Block: size, next, free
first_block: .word 0

.text
${lengthRuntimeFunction()}
${join(printRuntimeFunction().map(registerTransferExpressionToMips), '\n')}
${stringEqualityRuntimeFunction()}
${stringCopyRuntimeFunction()}
${join(myMallocRuntimeFunction().map(registerTransferExpressionToMips), '\n')}
${myFreeRuntimeFunction()}
${stringConcatenateRuntimeFunction()}
${verifyNoLeaks()}

${join(flatten(mipsFunctions).map(registerTransferExpressionToMips), '\n')}
main:
${makeSpillSpaceCode.join('\n')}
${join(mipsProgram.map(registerTransferExpressionToMips), '\n')}
${removeSpillSpaceCode.join('\n')}
${join(freeGlobals.map(registerTransferExpressionToMips), '\n')}
${registerTransferExpressionToMips({ kind: 'call', function: ' verify_no_leaks', why: 'Check for leaks' })}
# print "exit code" and exit
li $v0, 1
syscall
li $v0, 10
syscall`;
};

const execute = async (path: string): Promise<ExecutionResult> => {
    // This string is always printed with spim starts. Strip it from stdout. TODO: Look in to MARS, maybe it doesn't do this?
    const exceptionsLoadedPreamble = 'Loaded: /usr/local/Cellar/spim/9.1.17/share/exceptions.s\n';
    try {
        const result = await exec(`spim -file ${path}`);
        if (result.stderr !== '') {
            return { error: `Spim error: ${result.stderr}` };
        }
        const trimmedStdout = result.stdout.slice(exceptionsLoadedPreamble.length);
        const lines = trimmedStdout.split('\n');
        const mipsExitCode = parseInt(lines[lines.length - 1].match(/[0-9]*$/)[0]);
        return {
            exitCode: mipsExitCode,
            stdout: trimmedStdout.slice(0, trimmedStdout.length - mipsExitCode.toString().length),
        };
    } catch (e) {
        return {
            error: `Exception: ${e.message}`,
        };
    }
};

export default {
    name: 'mips',
    toExectuable,
    execute,
    debug: path => exec(`${__dirname}/../../QtSpim.app/Contents/MacOS/QtSpim ${path}`),
};
