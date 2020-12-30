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
    var ip = 0;
    let gotoLabel = (labelName: string) => {
        ip = main.instructions.findIndex(
            target => target.kind == 'label' && target.name == labelName
        );
        if (ip === -1) {
            throw debug('no label');
        }
    };
    while (true) {
        let i = main.instructions[ip];
        switch (i.kind) {
            case 'empty':
                break;
            case 'loadImmediate':
                registerValues[i.destination.name] = i.value;
                break;
            case 'move':
                registerValues[i.to.name] = registerValues[i.from.name];
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
            case 'goto':
                gotoLabel(i.label);
                break;
            case 'gotoIfZero':
                if (registerValues[i.register.name] === 0) {
                    gotoLabel(i.label);
                }
                break;
            case 'gotoIfEqual':
                if (registerValues[i.lhs.name] == registerValues[i.rhs.name]) {
                    gotoLabel(i.label);
                }
                break;
            case 'multiply':
                registerValues[i.destination.name] =
                    registerValues[i.lhs.name] * registerValues[i.rhs.name];
                break;
            case 'return':
                return {
                    exitCode: registerValues[i.register.name],
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
