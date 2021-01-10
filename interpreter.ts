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
    let state = { memory: {} };
    for (let name in globals) {
        var global = globals[name];
        state.memory[global.mangledName] = new Array(global.bytes);
        state.memory[global.mangledName].fill(0);
    }
    stringLiterals.forEach(stringLiteral => {
        let index = stringLiteralName(stringLiteral);
        state.memory[index] = [];
        for (var i = 0; i < stringLiteral.value.length; i++) {
            state.memory[index].push(stringLiteral.value.charCodeAt(i));
        }
        state.memory[index].push(0);
    });
    // TODO: make first_block less special-casey
    state.memory['first_block'] = [0];
    return state;
};

export const interpretFunction = (
    { globals, functions, main, stringLiterals }: Program,
    args: Argument[],
    state: State // modified
): number | Pointer | undefined => {
    if (!main) {
        throw debug('interpret rquires a main');
    }
    let registerValues: { [key: string]: number | Pointer } = {};
    args.forEach(arg => {
        registerValues[arg.name] = arg.value;
    });
    var ip = 0;
    let gotoLabel = (labelName: string) => {
        ip = main.instructions.findIndex(
            target => target.kind == 'label' && target.name == labelName
        );
        if (ip === -1) {
            throw debug('no label');
        }
    };
    let findFunction = (funcName: string) => {
        // TODO: Get the types right for pointers to functions
        let f = functions.find(f => f.name == funcName || f.name == (funcName as any).block);
        if (!f) throw debug('failed to find function');
        return f;
    };
    let getRegister = (from: number | Register): number | Pointer => {
        if (typeof from === 'number') {
            return from;
        }
        let regVal = registerValues[from.name];
        if (regVal !== undefined) {
            return regVal;
        }
        throw debug('unable to getRegister');
    };
    let getPointer = (from: Register): Pointer => {
        let val = getRegister(from);
        if (typeof val === 'number') throw debug('expected a pointer');
        return val;
    };
    let getValue = (from: number | Register): number => {
        let val = getRegister(from);
        if (typeof val !== 'number') throw debug('expected a value');
        return val;
    };
    let getName = (from: number | Register): string => {
        let val = getRegister(from);
        if (typeof val === 'number') throw debug('expected a name');
        return val.block;
    };
    let addToRegister = (name: string, amount: number) => {
        if (typeof registerValues[name] === 'number') {
            (registerValues as any)[name] += amount;
        } else {
            (registerValues as any)[name].offset += amount;
        }
    };
    let getGlobal = (from: string) => {
        if (from in globals) {
            // TODO: Tidy up which things are pointers and which are values
            from = globals[from].mangledName;
        }
        return state.memory[from][0];
    };
    let getMemory = (block: string, offset: number) => {
        let val = state.memory[block][offset];
        if (val === undefined) throw debug('bad mem access');
        return val;
    };
    var allocaCount = 0;
    var mmapCount = 0;
    while (true) {
        // One past the last instruction
        if (ip == main.instructions.length) {
            return undefined;
        }
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
                let pointer = getPointer(i.from);
                registerValues[i.to.name] = getMemory(pointer.block, pointer.offset + i.offset);
                break;
            case 'loadMemoryByte': {
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
                let pointer = getPointer(i.address);
                let value = getValue(i.from);
                state.memory[pointer.block][pointer.offset] = value;
                break;
            }
            case 'storeMemoryByte': {
                let pointer = getPointer(i.address);
                let value = getValue(i.contents);
                state.memory[pointer.block][pointer.offset] = value;
                break;
            }
            case 'storeZeroToMemory': {
                let pointer = getPointer(i.address);
                state.memory[pointer.block][pointer.offset + i.offset] = 0;
                break;
            }
            case 'loadGlobal':
                registerValues[i.to.name] = getGlobal(i.from);
                break;
            case 'callByRegister': {
                let func = findFunction(getName(i.function));
                let args = i.arguments;
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
                let func = findFunction(i.function);
                let args = i.arguments;
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
            case 'add':
                registerValues[i.destination.name] = getValue(i.lhs) + getValue(i.rhs);
                break;
            case 'addImmediate':
                addToRegister(i.register.name, i.amount);
                break;
            case 'subtract':
                let lhs = getRegister(i.lhs);
                let rhs = getValue(i.rhs);
                if (typeof lhs === 'number') {
                    registerValues[i.destination.name] = lhs - rhs;
                } else {
                    registerValues[i.destination.name] = { ...lhs, offset: lhs.offset - rhs };
                }
                break;
            case 'alloca':
                let blockName = `alloca_count_${allocaCount}`;
                allocaCount++;
                state.memory[blockName] = new Array(i.bytes);
                state.memory[blockName].fill(0);
                registerValues[i.register.name] = { block: blockName, offset: 0 };
                break;
            case 'syscall':
                switch (i.name) {
                    case 'print':
                        let stringName = getName(i.arguments[0]);
                        let string = stringLiterals[stringName];
                        if (typeof string !== 'string') throw debug('missing string');
                        console.log(string);
                        break;
                    case 'mmap':
                        let blockName = `mmap_count_${mmapCount}`;
                        mmapCount++;
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
    }
};

export const interpretProgram = (
    program: Program,
    args: Argument[],
    state: State /* modified */
): ExecutionResult => {
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
