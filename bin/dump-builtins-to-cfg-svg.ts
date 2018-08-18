#! /usr/bin/env node

import { allRuntimeFunctions } from '../threeAddressCode/runtime.js';
import { ThreeAddressStatement } from '../threeAddressCode/generator.js';
import { controlFlowGraph, toDotFile } from '../controlFlowGraph.js';
import writeSvg from '../util/graph/writeSvg.js';

allRuntimeFunctions.map(f => f(0)).forEach(async (f, index) => {
    const dot = toDotFile(controlFlowGraph(f.instructions));
    const path = `svgs/${(f[0] as any).name}_${index}.svg`;
    await writeSvg(dot, path);
});
