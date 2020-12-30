import debug from './util/debug';
import { Program } from './threeAddressCode/Program';
import { ExecutionResult } from './api';

export const interpret = ({
    globals,
    functions,
    main,
    stringLiterals,
}: Program): ExecutionResult => {
    if (!main) {
        throw debug('interpret rquires a main');
    }
    let registerValues = {};
    let globalValues = {};
    var result: undefined | number = undefined;
    main.instructions.forEach(i => {
        switch (i.kind) {
            case 'empty':
                break;
            case 'loadImmediate':
                registerValues[i.destination.name] = i.value;
                break;
            case 'return':
                result = registerValues[i.register.name];
                break;
            case 'loadSymbolAddress':
                registerValues[i.to.name] = i.symbolName;
                break;
            case 'storeGlobal':
                globalValues[i.to] = registerValues[i.from.name];
                break;
            case 'loadGlobal':
                registerValues[i.to.name] = globalValues[i.from];
                break;
            case 'callByRegister':
                let actualName = registerValues[i.function.name];
                let f = functions.find(f => f.name == actualName);
                if (!f) throw debug('failed to find function');
                let callResult = interpret({
                    functions,
                    globals,
                    stringLiterals,
                    main: f,
                });
                if (i.destination) {
                    registerValues[i.destination.name] = callResult;
                }
                break;
            case 'multiply':
                registerValues[i.destination.name] =
                    registerValues[i.lhs.name] * registerValues[i.rhs.name];
                break;
            default:
                debug(`${i.kind} unhandled in interpret`);
        }
    });
    if (result === undefined) {
        throw debug('no result');
    }
    return {
        exitCode: result,
        stdout: '',
        executorName: 'interpreter',
        runInstructions: 'none yet',
        debugInstructions: 'none yet',
    };
};
