import debug from '../util/debug.js';
import { Statement } from './statement.js';
import { Register, isEqual } from '../register.js';
import { RegisterAssignment, saveFunctionCallResult } from '../backend-utils.js';
import { RegisterDescription, TargetThreeAddressStatement } from './generator.js';

const getRegisterFromAssignment = <TargetRegister>(
    registerAssignment: RegisterAssignment<TargetRegister>,
    functionArguments: Register[], // TODO Maybe put the info about whether the register is an argument directly into the register?
    specialRegisters: RegisterDescription<TargetRegister>,
    r: Register
): TargetRegister => {
    const argIndex = functionArguments.findIndex(arg => isEqual(arg, r));
    if (typeof r == 'string') {
        // TODO: remove "result" hack register
        if (r != 'result') debug('bad register');
        return specialRegisters.functionResult;
    } else if (argIndex > -1) {
        // It's an argument!
        if (argIndex < specialRegisters.functionArgument.length) {
            return specialRegisters.functionArgument[argIndex];
        } else {
            throw debug('Need to load from stack I guess?');
        }
    } else {
        if (!r) debug('bad register');
        if (!(r.name in registerAssignment.registerMap)) {
            throw debug(
                `couldnt find an assignment for register: ${r.name}. Map: ${JSON.stringify(
                    registerAssignment.registerMap
                )}`
            );
        }
        return registerAssignment.registerMap[r.name];
    }
    throw debug('should not get here');
};

export default <TargetRegister>(
    tas: Statement,
    stackOffset: number,
    syscallNumbers,
    registers: RegisterDescription<TargetRegister>,
    functionArguments: Register[],
    registerAssignment: RegisterAssignment<TargetRegister>,
    exitLabel: string,
    registersClobberedBySyscall: TargetRegister[] // TDDO: accept a backend info?
): TargetThreeAddressStatement<TargetRegister>[] => {
    const getRegister = r =>
        getRegisterFromAssignment(registerAssignment, functionArguments, registers, r);
    switch (tas.kind) {
        case 'empty':
            return [];
        case 'return':
            return [
                {
                    kind: 'move',
                    from: getRegister(tas.register),
                    to: registers.functionResult,
                    why: 'Set return value',
                },
                { kind: 'goto', label: exitLabel, why: 'done' },
            ];
        case 'functionLabel':
        case 'goto':
        case 'label':
            return [tas];
        case 'syscall':
            // TODO: find a way to make this less opaque to register allocation so less spilling is necessary
            if (tas.arguments.length > registers.syscallArgument.length)
                throw debug(
                    `this backend only supports ${registers.syscallArgument.length} syscall args`
                );

            // We need to save some registers that the kernel is allowed to clobber during syscalls, ...
            const registersToSave: TargetRegister[] = [];

            // ... spcifically the place where the syscall stores the result ...
            if (
                tas.destination &&
                getRegister(tas.destination) != registers.syscallSelectAndResult
            ) {
                registersToSave.push(registers.syscallSelectAndResult);
            }

            // ... the registers used for arguments to the syscall ...
            tas.arguments.forEach((_, index) => {
                const argRegister = registers.syscallArgument[index];
                if (tas.destination && getRegister(tas.destination) == argRegister) {
                    return;
                }
                registersToSave.push(argRegister);
            });

            // ... any any explicitly clobberable registers.
            registersClobberedBySyscall.forEach(r => {
                registersToSave.push(r);
            });

            // TODO: Allow a "replacements" feature, to convert complex/unsupported RTL instructions into supported ones
            const syscallNumber = syscallNumbers[tas.name];
            if (syscallNumber === undefined) debug(`missing syscall number for (${tas.name})`);
            const result: TargetThreeAddressStatement<TargetRegister>[] = [
                ...registersToSave.map(r => ({
                    kind: 'push' as 'push',
                    register: r,
                    why: 'save registers',
                })),
                ...tas.arguments.map((arg, index) =>
                    typeof arg == 'number'
                        ? {
                              kind: 'loadImmediate' as 'loadImmediate',
                              value: arg,
                              destination: registers.syscallArgument[index],
                              why: 'syscallArg = immediate',
                          }
                        : {
                              kind: 'move' as 'move',
                              from: getRegister(arg),
                              to: registers.syscallArgument[index],
                              why: 'syscallArg = register',
                          }
                ),
                {
                    kind: 'loadImmediate',
                    value: syscallNumber,
                    destination: registers.syscallSelectAndResult,
                    why: `syscall select (${tas.name})`,
                },
                { kind: 'syscall', why: 'syscall' },
                ...(tas.destination
                    ? ([
                          {
                              kind: 'move',
                              from: registers.syscallSelectAndResult,
                              to: getRegister(tas.destination),
                              why: 'destination = syscallResult',
                          },
                      ] as TargetThreeAddressStatement<TargetRegister>[])
                    : []),
                ...registersToSave
                    .reverse()
                    .map(r => ({ kind: 'pop' as 'pop', register: r, why: 'restore registers' })),
            ];
            return result;
        case 'move':
            return [{ ...tas, to: getRegister(tas.to), from: getRegister(tas.from) }];
        case 'loadImmediate':
            return [{ ...tas, destination: getRegister(tas.destination) }];
        case 'add':
        case 'subtract':
        case 'multiply': {
            return [
                {
                    ...tas,
                    lhs: getRegister(tas.lhs),
                    rhs: getRegister(tas.rhs),
                    destination: getRegister(tas.destination),
                },
            ];
        }
        case 'addImmediate':
        case 'increment':
        case 'gotoIfZero':
            return [{ ...tas, register: getRegister(tas.register) }];
        case 'gotoIfNotEqual':
            if (typeof tas.rhs == 'number') {
                return [{ ...tas, lhs: getRegister(tas.lhs), rhs: tas.rhs }];
            }
            return [{ ...tas, lhs: getRegister(tas.lhs), rhs: getRegister(tas.rhs) }];
        case 'gotoIfEqual':
        case 'gotoIfGreater':
            return [{ ...tas, lhs: getRegister(tas.lhs), rhs: getRegister(tas.rhs) }];
        case 'loadSymbolAddress':
        case 'loadGlobal':
            return [{ ...tas, to: getRegister(tas.to) }];
        case 'storeGlobal':
            return [{ ...tas, from: getRegister(tas.from) }];
        case 'loadMemory':
            return [{ ...tas, to: getRegister(tas.to), from: getRegister(tas.from) }];
        case 'loadMemoryByte':
            return [{ ...tas, to: getRegister(tas.to), address: getRegister(tas.address) }];
        case 'storeMemory':
            return [{ ...tas, from: getRegister(tas.from), address: getRegister(tas.address) }];
        case 'storeZeroToMemory':
            return [{ ...tas, address: getRegister(tas.address) }];
        case 'storeMemoryByte':
            return [
                {
                    ...tas,
                    address: getRegister(tas.address),
                    contents: getRegister(tas.contents),
                },
            ];
        case 'callByName': {
            // Add moves to get all the arguments into place
            // TODO: Add some type check to ensure we have the right number of arguments
            // TODO: Compress with callByRegister
            const moveArgsIntoPlace: TargetThreeAddressStatement<
                TargetRegister
            >[] = tas.arguments.map((register, index) => {
                if (index < registers.functionArgument.length) {
                    if (typeof register == 'number') {
                        return {
                            kind: 'loadImmediate',
                            value: register,
                            destination: registers.functionArgument[index],
                            why: 'Rearrange Args',
                        };
                    } else {
                        return {
                            kind: 'move',
                            from: getRegister(register),
                            to: registers.functionArgument[index],
                            why: 'Rearrange Args',
                        };
                    }
                }
                return {
                    kind: 'push',
                    register: getRegister(register),
                    why: 'Rearrange Args',
                };
            });
            return [
                ...moveArgsIntoPlace,
                { kind: 'callByName', function: tas.function, why: 'actually call' },
                ...saveFunctionCallResult(tas.destination, getRegister, registers),
            ];
        }
        case 'callByRegister': {
            // Add moves to get all the arguments into place
            // TODO: Add some type check to ensure we have the right number of arguments
            const moveArgsIntoPlace: TargetThreeAddressStatement<
                TargetRegister
            >[] = tas.arguments.map((register, index) => {
                if (index < registers.functionArgument.length) {
                    if (typeof register == 'number') {
                        return {
                            kind: 'loadImmediate',
                            value: register,
                            destination: registers.functionArgument[index],
                            why: 'Rearrange Args',
                        };
                    } else {
                        return {
                            kind: 'move',
                            from: getRegister(register),
                            to: registers.functionArgument[index],
                            why: 'Rearrange Args',
                        };
                    }
                }
                return {
                    kind: 'push',
                    register: getRegister(register),
                    why: 'Rearrange Args',
                };
            });

            return [
                ...moveArgsIntoPlace,
                {
                    kind: 'callByRegister',
                    function: getRegister(tas.function),
                    why: 'actually call',
                },
                ...saveFunctionCallResult(tas.destination, getRegister, registers),
            ];
        }
        case 'alloca':
            return [
                {
                    kind: 'loadStackOffset',
                    register: getRegister(tas.register),
                    offset: stackOffset + tas.bytes,
                    why: tas.why,
                },
            ];
        case 'spill': {
            return [
                {
                    kind: 'stackStore',
                    register: getRegister(tas.register),
                    offset: stackOffset + tas.offset,
                    why: tas.why,
                },
            ];
        }
        case 'unspill': {
            if (Number.isNaN(stackOffset + tas.offset)) debug('nan!');
            return [
                {
                    kind: 'stackLoad',
                    register: getRegister(tas.register),
                    offset: stackOffset + tas.offset,
                    why: tas.why,
                },
            ];
        }
        default:
            throw debug(`${(tas as any).kind} unhandled in threeAddressCodeToTarget`);
    }
};
