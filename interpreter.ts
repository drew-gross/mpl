import debug from './util/debug';
import { Program } from './threeAddressCode/Program';
import { ExecutionResult } from './api';
import { Register } from './threeAddressCode/Register';
import { stringLiteralName } from './backend-utils';

export type Argument = {
    name: string;
    value: number | Pointer;
};

export type State = {
    memory: { [key: string]: (number | Pointer)[] };
};
type Pointer = {
    block: string;
    offset: number;
};

export const createInitialState = ({ stringLiterals, globals }: Program): State => {
    const state = { memory: {} };
    /* tslint:disable-next-line */
    for (const name in globals) {
        const global = globals[name];
        state.memory[global.mangledName] = new Array(global.bytes);
        state.memory[global.mangledName].fill(0);
    }
    stringLiterals.forEach(stringLiteral => {
        const index = stringLiteralName(stringLiteral);
        state.memory[index] = [];
        for (let i = 0; i < stringLiteral.value.length; i++) {
            state.memory[index].push(stringLiteral.value.charCodeAt(i));
        }
        state.memory[index].push(0);
    });
    // TODO: make first_block less special-casey
    /* tslint:disable-next-line */
    state.memory['first_block'] = [0];
    return state;
};

/* tslint:disable-next-line */
var isPointer = (val: number | Pointer): val is Pointer => {
    if (typeof val !== 'number') {
        return true;
    }
    return false;
};

export const interpretFunction = (
    { globals, functions, main, stringLiterals }: Program,
    args: Argument[],
    state: State // modified
): number | Pointer | undefined => {
    if (!main) {
        throw debug('interpret rquires a main');
    }
    /* tslint:disable-next-line */
    let registerValues: { [key: string]: number | Pointer } = {};
    args.forEach(arg => {
        registerValues[arg.name] = arg.value;
    });
    /* tslint:disable-next-line */
    var ip = 0;
    /* tslint:disable-next-line */
    var cycles = 0;
    /* tslint:disable-next-line */
    let gotoLabel = (labelName: string) => {
        ip = main.instructions.findIndex(
            target => target.kind == 'label' && target.name == labelName
        );
        if (ip === -1) {
            throw debug('no label');
        }
    };
    /* tslint:disable-next-line */
    let findFunction = (funcName: string) => {
        // TODO: Get the types right for pointers to functions
        /* tslint:disable-next-line */
        let f = functions.find(f => f.name == funcName || f.name == (funcName as any).block);
        if (!f) throw debug('failed to find function');
        return f;
    };
    /* tslint:disable-next-line */
    let getRegister = (from: number | Register): number | Pointer => {
        if (typeof from === 'number') {
            return from;
        }
        /* tslint:disable-next-line */
        let regVal = registerValues[from.name];
        if (regVal !== undefined) {
            return regVal;
        }
        throw debug('unable to getRegister');
    };
    /* tslint:disable-next-line */
    let getPointer = (from: Register): Pointer => {
        /* tslint:disable-next-line */
        let val = getRegister(from);
        if (typeof val === 'number') throw debug('expected a pointer');
        return val;
    };
    /* tslint:disable-next-line */
    let getValue = (from: number | Register): number => {
        /* tslint:disable-next-line */
        let val = getRegister(from);
        if (typeof val !== 'number') throw debug('expected a value');
        return val;
    };
    /* tslint:disable-next-line */
    let getName = (from: number | Register): string => {
        /* tslint:disable-next-line */
        let val = getRegister(from);
        if (typeof val === 'number') throw debug('expected a name');
        return val.block;
    };
    /* tslint:disable-next-line */
    let addToRegister = (name: string, amount: number) => {
        if (typeof registerValues[name] === 'number') {
            (registerValues as any)[name] += amount;
        } else {
            (registerValues as any)[name].offset += amount;
        }
    };
    /* tslint:disable-next-line */
    let getGlobal = (from: string) => {
        if (from in globals) {
            // TODO: Tidy up which things are pointers and which are values
            from = globals[from].mangledName;
        }
        return state.memory[from][0];
    };
    /* tslint:disable-next-line */
    let getMemory = (block: string, offset: number) => {
        /* tslint:disable-next-line */
        let val = state.memory[block][offset];
        // TODO: Make this an error instead, once I have a debugger set up
        if (val === undefined) return 0;
        return val;
    };
    /* tslint:disable-next-line */
    var allocaCount = 0;
    /* tslint:disable-next-line */
    var mmapCount = 0;
    while (true) {
        // One past the last instruction
        if (ip == main.instructions.length) {
            return undefined;
        }
        /* tslint:disable-next-line */
        let i = main.instructions[ip];
        switch (i.kind) {
            case 'empty':
                break;
            case 'label':
                break;
            case 'loadImmediate':
                registerValues[i.destination.name] = i.value;
                break;
            case 'move':
                registerValues[i.to.name] = getRegister(i.from);
                break;
            case 'loadSymbolAddress':
                registerValues[i.to.name] = { block: i.symbolName, offset: 0 };
                break;
            case 'loadMemory':
                /* tslint:disable-next-line */
                let pointer = getPointer(i.from);
                registerValues[i.to.name] = getMemory(pointer.block, pointer.offset + i.offset);
                break;
            case 'loadMemoryByte': {
                /* tslint:disable-next-line */
                let pointer = getRegister(i.address);
                if (typeof pointer === 'number') {
                    throw debug('expected a pointer');
                }
                registerValues[i.to.name] = getMemory(pointer.block, pointer.offset);
                break;
            }
            case 'storeGlobal':
                state.memory[i.to][0] = getRegister(i.from);
                break;
            case 'storeMemory': {
                /* tslint:disable-next-line */
                let pointer = getPointer(i.address);
                /* tslint:disable-next-line */
                let value = getValue(i.from);
                state.memory[pointer.block][pointer.offset] = value;
                break;
            }
            case 'storeMemoryByte': {
                /* tslint:disable-next-line */
                let pointer = getPointer(i.address);
                /* tslint:disable-next-line */
                let value = getValue(i.contents);
                state.memory[pointer.block][pointer.offset] = value;
                break;
            }
            case 'storeZeroToMemory': {
                /* tslint:disable-next-line */
                let pointer = getPointer(i.address);
                state.memory[pointer.block][pointer.offset + i.offset] = 0;
                break;
            }
            case 'loadGlobal':
                registerValues[i.to.name] = getGlobal(i.from);
                break;
            case 'callByRegister': {
                /* tslint:disable-next-line */
                let func = findFunction(getName(i.function));
                /* tslint:disable-next-line */
                let args = i.arguments;
                /* tslint:disable-next-line */
                let callResult = interpretFunction(
                    {
                        functions,
                        globals,
                        stringLiterals,
                        main: func,
                    },
                    func.arguments.map((arg, index) => ({
                        name: arg.name,
                        value: getRegister(args[index]),
                    })),
                    state
                );
                if (i.destination) {
                    if (callResult === undefined) {
                        throw debug('expected a result');
                    }
                    registerValues[i.destination.name] = callResult;
                }
                break;
            }
            case 'callByName': {
                /* tslint:disable-next-line */
                let func = findFunction(i.function);
                /* tslint:disable-next-line */
                let args = i.arguments;
                /* tslint:disable-next-line */
                let callResult = interpretFunction(
                    {
                        functions,
                        globals,
                        stringLiterals,
                        main: func,
                    },
                    func.arguments.map((arg, index) => ({
                        name: arg.name,
                        value: getRegister(args[index]),
                    })),
                    state
                );
                if (i.destination) {
                    if (callResult === undefined) {
                        throw debug('expected a result');
                    }
                    registerValues[i.destination.name] = callResult;
                }
                break;
            }
            case 'goto':
                gotoLabel(i.label);
                break;
            case 'gotoIfZero':
                if (registerValues[i.register.name] === 0) {
                    gotoLabel(i.label);
                }
                break;
            case 'gotoIfEqual':
                if (registerValues[i.lhs.name] == getRegister(i.rhs)) {
                    gotoLabel(i.label);
                }
                break;
            case 'gotoIfNotEqual':
                if (registerValues[i.lhs.name] != getRegister(i.rhs)) {
                    gotoLabel(i.label);
                }
                break;
            case 'gotoIfGreater':
                if (getRegister(i.lhs) > getRegister(i.rhs)) {
                    gotoLabel(i.label);
                }
                break;
            case 'multiply':
                registerValues[i.destination.name] = getValue(i.lhs) * getValue(i.rhs);
                break;
            case 'increment':
                addToRegister(i.register.name, 1);
                break;
            case 'add': {
                /* tslint:disable-next-line */
                let lhs = getRegister(i.lhs);
                /* tslint:disable-next-line */
                let rhs = getRegister(i.rhs);
                if (isPointer(lhs) && isPointer(rhs)) {
                    throw debug("Can't add 2 pointers");
                } else if (isPointer(lhs) && !isPointer(rhs)) {
                    registerValues[i.destination.name] = { ...lhs, offset: lhs.offset + rhs };
                } else if (isPointer(rhs) && !isPointer(lhs)) {
                    registerValues[i.destination.name] = { ...rhs, offset: rhs.offset + lhs };
                } else if (!isPointer(rhs) && !isPointer(lhs)) {
                    registerValues[i.destination.name] = lhs + rhs;
                }
                break;
            }
            case 'addImmediate':
                addToRegister(i.register.name, i.amount);
                break;
            case 'subtract': {
                /* tslint:disable-next-line */
                let lhs = getRegister(i.lhs);
                /* tslint:disable-next-line */
                let rhs = getValue(i.rhs);
                if (typeof lhs === 'number') {
                    registerValues[i.destination.name] = lhs - rhs;
                } else {
                    registerValues[i.destination.name] = { ...lhs, offset: lhs.offset - rhs };
                }
                break;
            }
            case 'alloca':
                /* tslint:disable-next-line */
                let blockName = `alloca_count_${allocaCount}`;
                allocaCount++;
                state.memory[blockName] = new Array(i.bytes);
                state.memory[blockName].fill(0);
                registerValues[i.register.name] = { block: blockName, offset: 0 };
                break;
            case 'syscall':
                switch (i.name) {
                    case 'print':
                        /* tslint:disable-next-line */
                        let stringName = getName(i.arguments[0]);
                        /* tslint:disable-next-line */
                        let string = stringLiterals[stringName];
                        if (typeof string !== 'string') throw debug('missing string');
                        console.log(string);
                        break;
                    case 'mmap':
                        /* tslint:disable-next-line */
                        let blockName = `mmap_count_${mmapCount}`;
                        mmapCount++;
                        /* tslint:disable-next-line */
                        let amount = getValue(i.arguments[1]);
                        state.memory[blockName] = new Array(amount);
                        state.memory[blockName].fill(0);
                        if (i.destination) {
                            registerValues[i.destination.name] = { block: blockName, offset: 0 };
                        }
                        break;
                    case 'exit':

                    default:
                        debug(`${i.name} unhandled in syscall interpreter`);
                }
                break;
            case 'return':
                return getRegister(i.register);
            default:
                debug(`${i.kind} unhandled in interpret`);
        }
        ip++;
        cycles++;
        if (cycles > 10000) {
            debug('Too many cycles');
        }
    }
};

export const interpretProgram = (
    program: Program,
    args: Argument[],
    state: State /* modified */
): ExecutionResult => {
    /* tslint:disable-next-line */
    let mainResult = interpretFunction(program, args, state);
    if (typeof mainResult !== 'number') throw debug('main should return a number');
    return {
        exitCode: mainResult,
        stdout: '',
        executorName: 'interpreter',
        runInstructions: 'none yet',
        debugInstructions: 'none yet',
    };
};
