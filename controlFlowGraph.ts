import debug from './util/debug.js';
import last from './util/list/last.js';
import sum from './util/list/sum.js';
import flatten from './util/list/flatten.js';
import { set, Set, join as setJoin } from './util/set.js';
import { filter, FilterPredicate } from './util/list/filter.js';
import join from './util/join.js';
import grid from './util/grid.js';
import { RegisterAssignment } from './backend-utils.js';
import { Register, isEqual as registerIsEqual } from './register.js';
import {
    RegisterTransferLanguageExpression as RTX,
    RegisterTransferLanguage as RTL,
    RegisterTransferLanguageFunction as RTLF,
    toString as rtxToString,
} from './backends/registerTransferLanguage.js';
import { Graph } from 'graphlib';

export type BasicBlock = {
    name: string;
    instructions: RTL;
};

export type ControlFlowGraph = {
    blocks: BasicBlock[];
    labelToIndexMap: { [key: string]: number };
    connections: {
        from: number;
        to: number;
    }[];
    // TODO: Have exit be a symbol, connections->{from, to} = number | exit
    exits: number[];
};

export type RegisterInterferenceGraph = {
    edgeList: Register[][];
};

const blockBehaviour = (rtx: RTX): 'endBlock' | 'beginBlock' | 'midBlock' => {
    switch (rtx.kind) {
        case 'comment':
        case 'syscall':
        case 'move':
        case 'loadImmediate':
        case 'addImmediate':
        case 'subtract':
        case 'add':
        case 'multiply':
        case 'increment':
        case 'storeGlobal':
        case 'loadGlobal':
        case 'storeMemory':
        case 'storeMemoryByte':
        case 'storeZeroToMemory':
        case 'loadMemory':
        case 'loadMemoryByte':
        case 'loadSymbolAddress':
        case 'callByName':
        case 'callByRegister':
        case 'push':
        case 'pop':
        case 'returnValue':
            return 'midBlock';
        case 'label':
        case 'functionLabel':
            return 'beginBlock';
        case 'returnToCaller':
        case 'goto':
        case 'gotoIfEqual':
        case 'gotoIfNotEqual':
        case 'gotoIfZero':
        case 'gotoIfGreater':
            return 'endBlock';
        default:
            throw debug('Unrecognized RTX kind in blockBehaviour');
    }
};

const livenessUpdate = (rtx: RTX): { newlyLive: Register[]; newlyDead: Register[] } => {
    switch (rtx.kind) {
        case 'comment':
            return { newlyLive: [], newlyDead: [] };
        case 'syscall':
            const predicate: FilterPredicate<Register | number, Register> = (arg: Register | number): arg is Register =>
                typeof arg !== 'number';
            const registerArguments: Register[] = filter<Register | number, Register>(rtx.arguments, predicate);
            return {
                newlyLive: registerArguments,
                newlyDead: rtx.destination ? [rtx.destination] : [],
            };
        case 'move':
            return { newlyLive: [rtx.from], newlyDead: [rtx.to] };
        case 'loadImmediate':
            return { newlyLive: [], newlyDead: [rtx.destination] };
        case 'addImmediate':
        case 'increment':
            return { newlyLive: [rtx.register], newlyDead: [] };
        case 'subtract':
        case 'add':
        case 'multiply':
            return { newlyLive: [rtx.lhs, rtx.rhs], newlyDead: [rtx.destination] };
        case 'storeGlobal':
            return { newlyLive: [rtx.from, rtx.to], newlyDead: [] };
        case 'loadGlobal':
            return { newlyLive: [], newlyDead: [rtx.to] };
        case 'storeMemory':
            return { newlyLive: [rtx.from, rtx.address], newlyDead: [] };
        case 'storeMemoryByte':
            return { newlyLive: [rtx.contents, rtx.address], newlyDead: [] };
        case 'storeZeroToMemory':
            return { newlyLive: [rtx.address], newlyDead: [] };
        case 'loadMemory':
            return { newlyLive: [rtx.from], newlyDead: [rtx.to] };
        case 'loadMemoryByte':
            return { newlyLive: [rtx.address], newlyDead: [rtx.to] };
        case 'loadSymbolAddress':
            return { newlyLive: [], newlyDead: [rtx.to] };
        case 'callByRegister':
            return { newlyLive: [rtx.function], newlyDead: [] };
        case 'push':
            return { newlyLive: [rtx.register], newlyDead: [] };
        case 'pop':
            return { newlyLive: [], newlyDead: [rtx.register] };
        case 'returnValue':
            return { newlyLive: [rtx.source], newlyDead: [] };
        case 'label':
        case 'callByName':
        case 'functionLabel':
        case 'returnToCaller':
        case 'goto':
            return { newlyLive: [], newlyDead: [] };
        case 'gotoIfEqual':
        case 'gotoIfNotEqual':
        case 'gotoIfGreater':
            return { newlyLive: [rtx.lhs, rtx.rhs], newlyDead: [] };
        case 'gotoIfZero':
            return { newlyLive: [rtx.register], newlyDead: [] };
        default:
            throw debug('Unrecognized RTX kind in blockBehaviour');
    }
};

const blockName = (rtl: RTL) => {
    if (rtl.length == 0) throw debug('empty rtl in blockName');
    const rtx = rtl[0];
    switch (rtx.kind) {
        case 'label':
        case 'functionLabel':
            return rtx.name;
        case 'goto':
        case 'gotoIfEqual':
        case 'gotoIfNotEqual':
        case 'gotoIfZero':
        case 'gotoIfGreater':
            return rtx.label;
        default:
            return '';
    }
};

type Exits = { blockName: string | false; next: boolean; exit: boolean };

const blockExits = (rtl: RTL): Exits => {
    const rtx = last(rtl);
    if (!rtx) throw debug('empty rtl');
    switch (rtx.kind) {
        case 'goto':
            return { blockName: rtx.label, next: false, exit: false };
        case 'gotoIfEqual':
        case 'gotoIfNotEqual':
        case 'gotoIfZero':
        case 'gotoIfGreater':
            return { blockName: rtx.label, next: true, exit: false };
        case 'returnToCaller':
            return { blockName: false, next: false, exit: true };
        case 'comment':
        case 'syscall':
        case 'move':
        case 'loadImmediate':
        case 'addImmediate':
        case 'subtract':
        case 'add':
        case 'multiply':
        case 'increment':
        case 'label':
        case 'functionLabel':
        case 'storeGlobal':
        case 'loadGlobal':
        case 'storeMemory':
        case 'storeMemoryByte':
        case 'storeZeroToMemory':
        case 'loadMemory':
        case 'loadMemoryByte':
        case 'loadSymbolAddress':
        case 'callByName':
        case 'callByRegister':
        case 'push':
        case 'pop':
            return { blockName: false, next: true, exit: false };
        default:
            throw debug('Unrecognized RTX kind in blockExits');
    }
};

export const toDotFile = ({ blocks, connections, labelToIndexMap, exits }: ControlFlowGraph): string => {
    let dotText = 'digraph {\n';
    dotText += `Entry [style="invis"]\n`;
    dotText += `Entry -> node_0\n`;

    blocks.forEach(({ name, instructions }, index) => {
        const label = join(instructions.map(rtxToString), '\\n')
            .replace(/"/g, '\\"')
            .replace(/:/g, '\\:');
        dotText += `node_${index} [shape="box", label="${label}"]`;
    });

    dotText += `Exit [style="invis"]\n`;
    exits.forEach(exit => {
        dotText += `node_${exit} -> Exit\n`;
    });
    connections.forEach(({ from, to }) => {
        dotText += `node_${from} -> node_${to}\n`;
    });
    dotText += '}';
    return dotText;
};

export const controlFlowGraph = (rtlf: RTLF): ControlFlowGraph => {
    let blocks: BasicBlock[] = [];
    var currentBlock: RTL = [];
    rtlf.instructions.forEach(rtx => {
        const change = blockBehaviour(rtx);
        if (change == 'midBlock') {
            currentBlock.push(rtx);
        } else if (change == 'endBlock') {
            currentBlock.push(rtx);
            blocks.push({
                instructions: currentBlock,
                name: blockName(currentBlock),
            });
            currentBlock = [];
        } else if (change == 'beginBlock') {
            if (currentBlock.length > 0) {
                blocks.push({
                    instructions: currentBlock,
                    name: blockName(currentBlock),
                });
            }
            currentBlock = [rtx];
        }
    });
    if (currentBlock.length > 0) {
        blocks.push({
            instructions: currentBlock,
            name: blockName(currentBlock),
        });
    }

    let labelToIndexMap = {};
    blocks.forEach((block, index) => {
        const firstRtx = block.instructions[0];
        if (firstRtx.kind == 'label' || firstRtx.kind == 'functionLabel') {
            labelToIndexMap[firstRtx.name] = index;
        }
    });

    let connections: { from: number; to: number }[] = [];
    let exits: number[] = [];
    blocks.forEach((block, index) => {
        const { blockName, next, exit } = blockExits(block.instructions);
        if (blockName) {
            connections.push({ from: index, to: labelToIndexMap[blockName] });
        }
        if (next) {
            connections.push({ from: index, to: index + 1 });
        }
        if (exit) {
            exits.push(index);
        }
    });

    return {
        blocks,
        connections,
        labelToIndexMap,
        exits,
    };
};

export const computeBlockLiveness = (block: BasicBlock) => {
    return block.instructions
        .slice()
        .reverse()
        .reduce(
            (liveness, next) => {
                const newLiveness = liveness[0].copy();
                const { newlyLive, newlyDead } = livenessUpdate(next);
                newlyDead.forEach(item => {
                    newLiveness.remove(item);
                });
                newlyLive.forEach(item => {
                    newLiveness.add(item);
                });
                return [newLiveness, ...liveness];
            },
            [set(registerIsEqual)]
        );
};

// Returns whether entry liveness changed
const propagateBlockLiveness = (block: BasicBlock, liveness: Set<Register>[], liveAtExit: Set<Register>): boolean => {
    const finalLiveness = last(liveness);
    if (!finalLiveness) return false;

    const stillPropagating = liveAtExit.copy();
    stillPropagating.toList().forEach(item => {
        if (finalLiveness.has(item)) {
            stillPropagating.remove(item);
            return;
        }
        finalLiveness.add(item);
        return;
    });

    for (let i = block.instructions.length - 1; i >= 0; i--) {
        let madeChanges = false;
        stillPropagating.toList().forEach(item => {
            if (liveness[i].has(item)) {
                stillPropagating.remove(item);
                return;
            }
            livenessUpdate(block.instructions[i]).newlyDead.forEach(dead => {
                stillPropagating.remove(dead);
                return;
            });
            liveness[i].add(item);
            madeChanges = true;
        });
        if (i == 0) {
            return madeChanges;
        }
    }
    throw debug('loop that should have never exited exited');
};

export const computeGraphLiveness = (cfg: ControlFlowGraph): Set<Register>[] => {
    const blockLiveness = cfg.blocks.map(computeBlockLiveness);
    const remainingToPropagate: { entryLiveness: Set<Register>; index: number }[] = blockLiveness.map((b, i) => ({
        entryLiveness: b[0],
        index: i,
    }));
    while (remainingToPropagate.length > 0) {
        const { entryLiveness, index } = remainingToPropagate.shift() as any;
        const preceedingNodeIndices = cfg.connections.filter(({ to }) => to == index).map(n => n.from);
        preceedingNodeIndices.forEach(index => {
            const changed = propagateBlockLiveness(cfg.blocks[index], blockLiveness[index], entryLiveness);
            if (changed) {
                remainingToPropagate.push({ entryLiveness: blockLiveness[index][0], index });
            }
        });
    }
    const overallLiveness: Set<Register>[] = [];
    for (let i = 0; i < blockLiveness.length - 2; i++) {
        const currentBlock = blockLiveness[i];
        const nextBlock = blockLiveness[i + 1];
        const lastLiveness = last(currentBlock);
        if (!lastLiveness) throw debug('empty block');
        if (!lastLiveness.isEqual(nextBlock[0])) throw debug('non-matching adjacent');
        overallLiveness.pop(); // Pop empty list is OK
        overallLiveness.push(...currentBlock);
    }
    // add final block completely
    overallLiveness.push(...(last(blockLiveness) || []));
    if (sum(cfg.blocks.map(b => b.instructions.length)) + 1 != overallLiveness.length) {
        throw debug('overallLiveness length mimatch');
    }
    return overallLiveness;
};

export const liveness = (rtlf: RTLF) => computeGraphLiveness(controlFlowGraph(rtlf));

export const registerInterferenceGraph = (liveness: Set<Register>[]): RegisterInterferenceGraph => {
    const allRegisters = setJoin(registerIsEqual, liveness);
    const result: RegisterInterferenceGraph = {
        edgeList: [],
    };
    liveness.forEach(registers => {
        registers.toList().forEach(i => {
            registers.toList().forEach(j => {
                result.edgeList.push([i, j]);
            });
        });
    });
    return result;
};

export const assignRegisters = (rtlf: RTLF): RegisterAssignment => {
    const cfg = controlFlowGraph(rtlf);
    const liveness = computeGraphLiveness(cfg);
    const rig = registerInterferenceGraph(liveness);
    throw debug('TODO: implement assignRegisters');
};
