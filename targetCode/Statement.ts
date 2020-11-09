import debug from '../util/debug';
import {
    Statement as ThreeAddressStatement,
    StackLocation,
} from '../threeAddressCode/statement';
import { Register, isEqual } from '../threeAddressCode/Register';
import { RegisterAssignment, saveFunctionCallResult } from '../backend-utils';
import { TargetInfo, TargetRegisters } from '../TargetInfo';
import { StackUsage, offset } from './StackUsage';

// TODO: remove this probably
export type DataLocation<TargetRegister> =
    | { kind: 'register'; register: TargetRegister }
    | { kind: 'stack'; offset: number /* TODO: offset maybe in the wrong place? */ }
    // Returned when input to argumentLocation isn't an argument. TODO: we should know before calling argumentLocation whether it's an argument or not.
    | { kind: 'not_argument' };

export const argumentStackLocation = <TargetRegister>(
    targetInfo: TargetInfo<TargetRegister>,
    functionArgs: Register[],
    register: Register
): StackLocation | undefined => {
    const argIndex = functionArgs.findIndex(arg => isEqual(arg, register));
    if (argIndex < 0) {
        // not an arg
        return undefined;
    } else if (argIndex < targetInfo.registers.functionArgument.length) {
        // not passed in stack
        return undefined;
    } else {
        return {
            kind: 'argument',
            argNumber: argIndex - targetInfo.registers.functionArgument.length,
        };
    }
};

const arrangeArgumentsForFunctionCall = <TargetRegister>(
    args: (Register | Number)[],
    getRegister: (r: Register) => TargetRegister,
    targetInfo: TargetInfo<TargetRegister>
): Statement<TargetRegister>[] => {
    // TODO: Add some type check to ensure we have the right number of arguments
    return args.map((arg, index) => {
        // TODO: Reuse the code in argumentLocation here
        if (index < targetInfo.registers.functionArgument.length) {
            // Registers that fix in arguments go in arguments
            if (typeof arg == 'number') {
                return {
                    kind: 'loadImmediate',
                    value: arg,
                    destination: targetInfo.registers.functionArgument[index],
                    why: `Pass arg ${index} in register`,
                };
            } else {
                return {
                    kind: 'move',
                    from: getRegister(arg as Register),
                    to: targetInfo.registers.functionArgument[index],
                    why: `Pass arg ${index} in register`,
                };
            }
        } else {
            // Registers that don't fit in arguments go on the stack, starting 1 space above the current stack pointer, going up. TODO: This puts data above the top of the stack, which is not safe on some platforms, as that space may be used by interrupts or the kernel after an involuntary context switch. Some platforms have a "red zone", on those platforms this is safe, but we should only do it when we know it's safe. See https://eli.thegreenplace.net/2011/09/06/stack-frame-layout-on-x86-64.
            if (typeof arg == 'number') {
                throw debug(
                    "arrangeArgumentsForFunctionCall doesn't support literals on stack yet"
                );
            } else {
                const stackSlot =
                    index -
                    targetInfo.registers.functionArgument.length +
                    targetInfo.callerSavedRegisters.length;
                return {
                    kind: 'stackStore',
                    register: getRegister(arg as Register),
                    offset: -stackSlot,
                    why: `Pass arg ${index} on stack (slot ${stackSlot})`,
                };
            }
        }
    });
};

const dataLocation = <TargetRegister>(
    registerAssignment: RegisterAssignment<TargetRegister>,
    functionArguments: Register[],
    registers: TargetRegisters<TargetRegister>,
    register: Register
): DataLocation<TargetRegister> => {
    const argIndex = functionArguments.findIndex(arg => isEqual(arg, register));
    if (argIndex > -1) {
        // This is an argument
        if (argIndex < registers.functionArgument.length) {
            return { kind: 'register', register: registers.functionArgument[argIndex] };
        } else {
            return { kind: 'stack', offset: argIndex - registers.functionArgument.length };
        }
    } else {
        // This is a temporary or local
        if (!register) debug('bad register');
        if (!(register.name in registerAssignment.registerMap)) {
            throw debug(
                `couldnt find an assignment for register: ${
                    register.name
                }. Map: ${JSON.stringify(registerAssignment.registerMap)}`
            );
        }
        return { kind: 'register', register: registerAssignment.registerMap[register.name] };
    }
    debug('should not get here');
};

const getRegisterFromAssignment = <TargetRegister>(
    registerAssignment: RegisterAssignment<TargetRegister>,
    functionArguments: Register[], // TODO Maybe put the info about whether the register is an argument directly into the register?
    registers: TargetRegisters<TargetRegister>,
    r: Register
): TargetRegister => {
    const location = dataLocation(registerAssignment, functionArguments, registers, r);
    if (location.kind !== 'register') {
        throw debug('expected a register');
    }
    return location.register;
};

export type Statement<TargetRegister> = { why: string } & (
    | { kind: 'comment' }
    // Arithmetic
    | { kind: 'move'; from: TargetRegister; to: TargetRegister }
    | { kind: 'loadImmediate'; value: number; destination: TargetRegister }
    | { kind: 'addImmediate'; register: TargetRegister; amount: number }
    | { kind: 'subtract'; lhs: TargetRegister; rhs: TargetRegister; destination: TargetRegister }
    | { kind: 'add'; lhs: TargetRegister; rhs: TargetRegister; destination: TargetRegister }
    | { kind: 'multiply'; lhs: TargetRegister; rhs: TargetRegister; destination: TargetRegister }
    | { kind: 'increment'; register: TargetRegister }
    // Labels
    | { kind: 'label'; name: string }
    | { kind: 'functionLabel'; name: string }
    // Branches
    | { kind: 'goto'; label: string }
    | { kind: 'gotoIfEqual'; lhs: TargetRegister; rhs: TargetRegister; label: string }
    | {
          kind: 'gotoIfNotEqual';
          lhs: TargetRegister;
          rhs: TargetRegister | number;
          label: string;
      }
    | { kind: 'gotoIfZero'; register: TargetRegister; label: string }
    | { kind: 'gotoIfGreater'; lhs: TargetRegister; rhs: TargetRegister; label: string }
    // Memory Writes
    | { kind: 'storeGlobal'; from: TargetRegister; to: string }
    | { kind: 'storeMemory'; from: TargetRegister; address: TargetRegister; offset: number }
    | { kind: 'storeMemoryByte'; address: TargetRegister; contents: TargetRegister }
    | { kind: 'storeZeroToMemory'; address: TargetRegister; offset: number }
    // Memory Reads
    | { kind: 'loadGlobal'; from: string; to: TargetRegister }
    | { kind: 'loadMemory'; from: TargetRegister; to: TargetRegister; offset: number }
    | { kind: 'loadMemoryByte'; address: TargetRegister; to: TargetRegister }
    | { kind: 'loadSymbolAddress'; to: TargetRegister; symbolName: string }
    // Function calls
    | { kind: 'syscall' }
    | { kind: 'callByName'; function: string }
    | { kind: 'callByRegister'; function: TargetRegister }
    | { kind: 'return' }
    // Stack Management
    | { kind: 'loadStackOffset'; register: TargetRegister; offset: number } // TODO: This is alloca, gets the address of a stack object
    | { kind: 'stackStore'; register: TargetRegister; offset: number }
    | { kind: 'stackLoad'; register: TargetRegister; offset: number }
    | { kind: 'stackReserve'; words: number }
    | { kind: 'stackRelease'; words: number }
    | { kind: 'push'; register: TargetRegister }
    | { kind: 'pop'; register: TargetRegister }
);

export type ToTargetInput<TargetRegister> = {
    tas: ThreeAddressStatement;
    functionArguments: Register[];
    targetInfo: TargetInfo<TargetRegister>;
    stackOffset: number;
    stackFrameSize: number;
    stackUsage: StackUsage<TargetRegister>;
    registerAssignment: RegisterAssignment<TargetRegister>;
    exitLabel: string;
};

export const toTarget = <TargetRegister>({
    tas,
    functionArguments,
    targetInfo,
    stackOffset,
    stackFrameSize,
    stackUsage,
    registerAssignment,
    exitLabel,
}: ToTargetInput<TargetRegister>): Statement<TargetRegister>[] => {
    const getRegister = (r: Register): TargetRegister =>
        getRegisterFromAssignment(
            registerAssignment,
            functionArguments,
            targetInfo.registers,
            r
        );
    switch (tas.kind) {
        case 'empty':
            return [];
        case 'return':
            return [
                {
                    kind: 'move',
                    from: getRegister(tas.register),
                    to: targetInfo.registers.functionResult,
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
            if (tas.arguments.length > targetInfo.registers.syscallArgument.length)
                throw debug(
                    `this backend only supports ${targetInfo.registers.syscallArgument.length} syscall args`
                );

            // We need to save some registers that the kernel is allowed to clobber during syscalls, ...
            const registersToSave: TargetRegister[] = [];

            // ... spcifically the place where the syscall stores the result ...
            if (
                tas.destination &&
                getRegister(tas.destination) != targetInfo.registers.syscallSelectAndResult
            ) {
                registersToSave.push(targetInfo.registers.syscallSelectAndResult);
            }

            // ... the registers used for arguments to the syscall ...
            tas.arguments.forEach((_, index) => {
                const argRegister = targetInfo.registers.syscallArgument[index];
                if (tas.destination && getRegister(tas.destination) == argRegister) {
                    return;
                }
                registersToSave.push(argRegister);
            });

            // ... any any explicitly clobberable registers.
            targetInfo.registersClobberedBySyscall.forEach(r => {
                registersToSave.push(r);
            });

            // TODO: Allow a "replacements" feature, to convert complex/unsupported RTL instructions into supported ones
            const syscallNumber = targetInfo.registerAgnosticInfo.syscallNumbers[tas.name];
            if (syscallNumber === undefined) debug(`missing syscall number for (${tas.name})`);
            const result: Statement<TargetRegister>[] = [
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
                              destination: targetInfo.registers.syscallArgument[index],
                              why: 'syscallArg = immediate',
                          }
                        : {
                              kind: 'move' as 'move',
                              from: getRegister(arg),
                              to: targetInfo.registers.syscallArgument[index],
                              why: 'syscallArg = register',
                          }
                ),
                {
                    kind: 'loadImmediate',
                    value: syscallNumber,
                    destination: targetInfo.registers.syscallSelectAndResult,
                    why: `syscall select (${tas.name})`,
                },
                { kind: 'syscall', why: 'syscall' },
                ...(tas.destination
                    ? ([
                          {
                              kind: 'move',
                              from: targetInfo.registers.syscallSelectAndResult,
                              to: getRegister(tas.destination),
                              why: 'destination = syscallResult',
                          },
                      ] as Statement<TargetRegister>[])
                    : []),
                ...registersToSave.reverse().map(r => ({
                    kind: 'pop' as 'pop',
                    register: r,
                    why: 'restore registers',
                })),
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
            return [
                ...arrangeArgumentsForFunctionCall(tas.arguments, getRegister, targetInfo),
                {
                    kind: 'callByName',
                    function: tas.function,
                    why: `actually call (${tas.why})`,
                },
                ...saveFunctionCallResult(tas.destination, getRegister, targetInfo.registers),
            ];
        }
        case 'callByRegister': {
            return [
                ...arrangeArgumentsForFunctionCall(tas.arguments, getRegister, targetInfo),
                {
                    kind: 'callByRegister',
                    function: getRegister(tas.function),
                    why: 'actually call',
                },
                ...saveFunctionCallResult(tas.destination, getRegister, targetInfo.registers),
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
        case 'storeStack': {
            return [
                {
                    kind: 'stackStore',
                    register: getRegister(tas.register),
                    offset: offset(stackUsage, tas.register),
                    why: tas.why,
                },
            ];
        }
        case 'loadStack':
            return [
                {
                    kind: 'stackLoad',
                    // TODO: Need to refactor StackUsage
                    register: getRegister(tas.register),
                    offset: offset(stackUsage, tas.register),
                    why: tas.why,
                },
            ];
        default:
            throw debug(`${(tas as any).kind} unhandled in threeAddressCodeToTarget`);
    }
};
