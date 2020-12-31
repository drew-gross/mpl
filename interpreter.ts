import debug from './util/debug';
import { Program } from './threeAddressCode/Program';
import { ExecutionResult } from './api';
import { Register } from './threeAddressCode/Register';

export type Argument = {
    name: string;
    value: number;
};

export const interpret = (
    { globals, functions, main, stringLiterals }: Program,
    args: Argument[]
): ExecutionResult => {
    if (!main) {
        throw debug('interpret rquires a main');
    }
    let registerValues = {};
    let globalValues = {};
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
        let f = functions.find(f => f.name == funcName);
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
        let argVal = args.find(arg => arg.name == from.name);
        if (argVal !== undefined) {
            return argVal.value;
        }
        throw debug('unable to getVal');
    };
    let getMemory = (symbolName: string, offset: number) => {
        if (!(symbolName in globalValues)) {
            globalValues[symbolName] = [];
        }
        while (globalValues[symbolName].length <= offset) {
            globalValues[symbolName].push(0);
        }
        return globalValues[symbolName][offset];
    };
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
                registerValues[i.to.name] = i.symbolName;
                break;
            case 'loadMemory':
                let pointer = getVal(i.from);
                registerValues[i.to.name] = getMemory(pointer, i.offset);
                break;
            case 'storeGlobal':
                globalValues[i.to] = getVal(i.from);
                break;
            case 'loadGlobal':
                registerValues[i.to.name] = globalValues[i.from];
                break;
            case 'callByRegister': {
                let actualName = getVal(i.function);
                let func = findFunction(actualName);
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
                    }))
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
                    }))
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
            case 'add':
                registerValues[i.destination.name] = getVal(i.lhs) + getVal(i.rhs);
                break;
            case 'addImmediate':
                registerValues[i.register.name] += i.amount;
                break;
            case 'syscall':
                switch (i.name) {
                    case 'print':
                        let stringName = getVal(i.arguments[0]);
                        console.log(stringLiterals[stringName]);
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
