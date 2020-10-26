import { compile } from './frontend';
import jsBackend from './backends/js';
import { format } from 'prettier';

export function mplLoader(source: string, context: any) {
    const frontendOutput = compile(source);
    if (
        'parseErrors' in frontendOutput ||
        'typeErrors' in frontendOutput ||
        'kind' in frontendOutput ||
        'internalError' in frontendOutput
    ) {
        context.emitError(new Error(JSON.stringify(frontendOutput)));
        return;
    }
    const js = jsBackend.compile(frontendOutput);
    if ('error' in js) {
        context.emitError(new Error(JSON.stringify(js.error)));
        return;
    }
    debugger;
    return format(js.target);
}
