import { compile } from './frontend';
// import jsBackend from './backends/js';

export default function(source: string) {
    const frontendOutput = compile(source);
    if (
        'parseErrors' in frontendOutput ||
        'typeErrors' in frontendOutput ||
        'kind' in frontendOutput ||
        'internalError' in frontendOutput
    ) {
        this.emitError('ooops');
    }
}
