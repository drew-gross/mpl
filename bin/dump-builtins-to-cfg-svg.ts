#! /usr/bin/env node

import mipsBackend from '../backends/mips.js';
import x64Backend from '../backends/x64.js';
import { controlFlowGraph, toDotFile } from '../controlFlowGraph.js';
import writeSvg from '../util/graph/writeSvg.js';
import { RegisterTransferLanguageFunction as RTLF } from '../backends/registerTransferLanguage.js';

[...mipsBackend.runtimeFunctions, ...x64Backend.runtimeFunctions].forEach(async (f: RTLF, index) => {
    const dot = toDotFile(controlFlowGraph(f));
    const path = `svgs/${(f[0] as any).name}_${index}.svg`;
    await writeSvg(dot, path);
});
