import { compile } from './frontend';
import jsBackend from './backends/js';

function mplLoader(source: string) {
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
    console.log('asdasd');
    return js.target;
}

export default mplLoader;
