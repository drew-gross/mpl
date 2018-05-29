#! /usr/bin/env node

import mipsBackend from '../backends/mips.js';
import x64Backend from '../backends/x64.js';
import { controlFlowGraph, toDotFile } from '../controlFlowGraph.js';
import writeSvg from '../util/graph/writeSvg.js';

[...mipsBackend.runtimeFunctions, ...x64Backend.runtimeFunctions].forEach(async (f, index) => {
    const dot = toDotFile(controlFlowGraph(f.instructions));
    const path = `svgs/${(f[0] as any).name}_${index}.svg`;
    await writeSvg(dot, path);
});
