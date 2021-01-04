import debug from './util/debug';
import { Program } from './threeAddressCode/Program';
import { ExecutionResult } from './api';
import { Register } from './threeAddressCode/Register';
import { stringLiteralName } from './backend-utils';

export type Argument = {
    name: string;
    value: number;
};

export type State = {
    globalValues: object;
    memory: { [key: string]: number[] };
};
type Pointer = {
    block: string;
    offset: number;
};

export const createInitialState = ({ stringLiterals, globals }: Program): State => {
    let state = {
        globalValues: {},
        memory: {},
    };
    for (let name in globals) {
        state.globalValues[name] = {};
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

export const interpret = (
    { globals, functions, main, stringLiterals }: Program,
    args: Argument[],
    state: State // modified
): ExecutionResult => {
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
    let getVal = (from: number | Register): any => {
        if (typeof from === 'number') {
            return from;
        }
        let regVal = registerValues[from.name];
        if (regVal !== undefined) {
            return regVal;
        }
        throw debug('unable to getVal');
    };
    let addToRegister = (name: string, amount: number) => {
        if (typeof registerValues[name] === 'number') {
            (registerValues as any)[name] += amount;
        } else {
            (registerValues as any)[name].offset += amount;
        }
    };
    let getGlobal = (from: string) => {
        if (!(from in state.globalValues)) {
            throw debug('Missing global');
        }
        return state.globalValues[from];
    };
    let getMemory = (block: string, offset: number) => {
        let val = state.memory[block][offset];
        if (val === undefined) throw debug('bad mem access');
        return val;
    };
    var allocaCount = 0;
    while (true) {
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
                registerValues[i.to.name] = getVal(i.from);
                break;
            case 'loadSymbolAddress':
                registerValues[i.to.name] = { block: i.symbolName, offset: 0 };
                break;
            case 'loadMemory':
                let pointer = getVal(i.from);
                registerValues[i.to.name] = getMemory(pointer.block, pointer.offset + i.offset);
                break;
            case 'loadMemoryByte': {
                let pointer = getVal(i.address);
                if (typeof pointer === 'number') {
                    throw debug('expected a pointer');
                }
                registerValues[i.to.name] = getMemory(pointer.block, pointer.offset);
                break;
            }
            case 'storeGlobal':
                state.globalValues[i.to] = getVal(i.from);
                break;
            case 'loadGlobal':
                registerValues[i.to.name] = getGlobal(i.from);
                break;
            case 'callByRegister': {
                let func = findFunction(getVal(i.function));
                let args = i.arguments;
                let callResult = interpret(
                    {
                        functions,
                        globals,
                        stringLiterals,
                        main: func,
                    },
                    func.arguments.map((arg, index) => ({
                        name: arg.name,
                        value: getVal(args[index]),
                    })),
                    state
                );
                if ('error' in callResult) {
                    throw debug(`error: ${callResult.error}`);
                }
                if (i.destination) {
                    registerValues[i.destination.name] = callResult.exitCode;
                }
                break;
            }
            case 'callByName': {
                let func = findFunction(i.function);
                let args = i.arguments;
                let callResult = interpret(
                    {
                        functions,
                        globals,
                        stringLiterals,
                        main: func,
                    },
                    func.arguments.map((arg, index) => ({
                        name: arg.name,
                        value: getVal(args[index]),
                    })),
                    state
                );
                if ('error' in callResult) {
                    throw debug(`error: ${callResult.error}`);
                }
                if (i.destination) {
                    registerValues[i.destination.name] = callResult.exitCode;
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
                if (registerValues[i.lhs.name] == getVal(i.rhs)) {
                    gotoLabel(i.label);
                }
                break;
            case 'gotoIfGreater':
                if (getVal(i.lhs) > getVal(i.rhs)) {
                    gotoLabel(i.label);
                }
                break;
            case 'multiply':
                registerValues[i.destination.name] = getVal(i.lhs) * getVal(i.rhs);
                break;
            case 'increment':
                addToRegister(i.register.name, 1);
                break;
            case 'add':
                registerValues[i.destination.name] = getVal(i.lhs) + getVal(i.rhs);
                break;
            case 'addImmediate':
                addToRegister(i.register.name, i.amount);
                break;
            case 'subtract':
                registerValues[i.destination.name] = getVal(i.lhs) - getVal(i.rhs);
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
                        let stringName = getVal(i.arguments[0]);
                        let string = stringLiterals[stringName];
                        if (typeof string !== 'string') throw debug('missing string');
                        console.log(string);
                        break;
                    case 'exit':

                    default:
                        debug(`${i.name} unhandled in syscall interpreter`);
                }
                break;
            case 'return':
                return {
                    exitCode: getVal(i.register),
                    stdout: '',
                    executorName: 'interpreter',
                    runInstructions: 'none yet',
                    debugInstructions: 'none yet',
                };
            default:
                debug(`${i.kind} unhandled in interpret`);
        }
        ip++;
    }
};
