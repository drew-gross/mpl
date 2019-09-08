import debug from '../util/debug.js';
import { Statement } from './statement.js';
import { Register } from '../register.js';
import { RegisterDescription } from '../backend-utils.js';
import { TargetThreeAddressStatement } from './generator.js';

export default <TargetRegister>(
    tas: Statement,
    stackOffset: number,
    syscallNumbers,
    registerTypes: RegisterDescription<TargetRegister>,
    getRegister: (r: Register) => TargetRegister,
    registersClobberedBySyscall: TargetRegister[] // TDDO: accept a backend info?
): TargetThreeAddressStatement<TargetRegister>[] => {
    switch (tas.kind) {
        case 'empty':
            return [];
        case 'functionLabel':
        case 'returnToCaller':
        case 'goto':
        case 'label':
            return [tas];
        case 'syscallWithResult':
        case 'syscallWithoutResult':
            // TOOD: DRY with syscall impl in mips
            // TODO: find a way to make this less opaque to register allocation so less spilling is necessary
            if (tas.arguments.length > registerTypes.syscallArgument.length)
                throw debug(`this backend only supports ${registerTypes.syscallArgument.length} syscall args`);

            // We need to save some registers that the kernel is allowed to clobber during syscalls, ...
            const registersToSave: TargetRegister[] = [];

            // ... spcifically the place where the syscall stores the result ...
            if ('destination' in tas && getRegister(tas.destination) != registerTypes.syscallSelectAndResult) {
                registersToSave.push(registerTypes.syscallSelectAndResult);
            }

            // ... the registers used for arguments to the syscall ...
            tas.arguments.forEach((_, index) => {
                const argRegister = registerTypes.syscallArgument[index];
                if ('destination' in tas && getRegister(tas.destination) == argRegister) {
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
                              destination: registerTypes.syscallArgument[index],
                              why: 'syscallArg = immediate',
                          }
                        : {
                              kind: 'move' as 'move',
                              from: getRegister(arg),
                              to: registerTypes.syscallArgument[index],
                              why: 'syscallArg = register',
                          }
                ),
                {
                    kind: 'loadImmediate',
                    value: syscallNumber,
                    destination: registerTypes.syscallSelectAndResult,
                    why: `syscall select (${tas.name})`,
                },
                { kind: 'syscall', why: 'syscall' },
                ...('destination' in tas
                    ? ([
                          {
                              kind: 'move',
                              from: registerTypes.syscallSelectAndResult,
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
            return [{ ...tas, address: getRegister(tas.address), contents: getRegister(tas.contents) }];
        case 'callByName': {
            // Add moves to get all the arguments into place
            // TODO: Add some type check to ensure we have the right number of arguments
            // TODO: Compress with callByRegister
            const moveArgsIntoPlace: TargetThreeAddressStatement<TargetRegister>[] = tas.arguments.map(
                (register, index) => {
                    if (typeof register == 'number') {
                        return {
                            kind: 'loadImmediate',
                            value: register,
                            destination: registerTypes.functionArgument[index],
                            why: 'Rearrange Args',
                        };
                    } else {
                        return {
                            kind: 'move',
                            from: getRegister(register),
                            to: registerTypes.functionArgument[index],
                            why: 'Rearrange Args',
                        };
                    }
                }
            );
            return [...moveArgsIntoPlace, tas];
        }
        case 'callByRegister': {
            // Add moves to get all the arguments into place
            // TODO: Add some type check to ensure we have the right number of arguments
            const moveArgsIntoPlace: TargetThreeAddressStatement<TargetRegister>[] = tas.arguments.map(
                (register, index) => {
                    if (typeof register == 'number') {
                        return {
                            kind: 'loadImmediate',
                            value: register,
                            destination: registerTypes.functionArgument[index],
                            why: 'Rearrange Args',
                        };
                    } else {
                        return {
                            kind: 'move',
                            from: getRegister(register),
                            to: registerTypes.functionArgument[index],
                            why: 'Rearrange Args',
                        };
                    }
                }
            );
            return [...moveArgsIntoPlace, { ...tas, function: getRegister(tas.function) }];
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
