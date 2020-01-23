import { compile } from './frontend';
import jsBackend from './backends/js';

export default function(source: string) {
    const frontendOutput = compile(source);
    if (
        'parseErrors' in frontendOutput ||
        'typeErrors' in frontendOutput ||
        'kind' in frontendOutput ||
        'internalError' in frontendOutput
    ) {
        this.emitError(frontendOutput);
        return;
    }
    const js = jsBackend.compile(frontendOutput);
    if ('error' in js) {
        this.emitError(js.error);
        return;
    }
    return js.target;
}
