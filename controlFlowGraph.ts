import debug from './util/debug.js';
import last from './util/list/last.js';
import join from './util/join.js';
import {
    RegisterTransferLanguageExpression as RTX,
    toString as rtxToString,
} from './backends/registerTransferLanguage.js';
import { Graph } from 'graphlib';

export type BasicBlock = {
    name: string;
    instructions: RTX[];
};

export type ControlFlowGraph = {
    blocks: BasicBlock[];
    connections: {
        from: string;
        to: string;
    }[];
    // TODO: Have entry and exit be symbols, connections->{from, to} = string | entry | exit
    entry: string;
    exits: string[];
};

const isBlockEnd = (rtx: RTX): boolean => {
    switch (rtx.kind) {
        case 'comment':
            return false;
        case 'syscall':
            return false;
        case 'move':
            return false;
        case 'loadImmediate':
            return false;
        case 'addImmediate':
            return false;
        case 'subtract':
            return false;
        case 'add':
            return false;
        case 'multiply':
            return false;
        case 'increment':
            return false;
        case 'label':
            return true;
        case 'functionLabel':
            return false;
        case 'goto':
            return true;
        case 'gotoIfEqual':
            return true;
        case 'gotoIfNotEqual':
            return true;
        case 'gotoIfZero':
            return true;
        case 'gotoIfGreater':
            return true;
        case 'storeGlobal':
            return false;
        case 'loadGlobal':
            return false;
        case 'storeMemory':
            return false;
        case 'storeMemoryByte':
            return false;
        case 'storeZeroToMemory':
            return false;
        case 'loadMemory':
            return false;
        case 'loadMemoryByte':
            return false;
        case 'loadSymbolAddress':
            return false;
        case 'call':
            return false;
        case 'returnToCaller':
            return false;
        case 'returnValue':
            return true;
        case 'push':
            return false;
        case 'pop':
            return false;
        default:
            throw debug('Unrecognized RTX kind in isBlockEnd');
    }
};

const blockName = (rtl: RTX[]) => {
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
            throw debug('Unrecognized RTX kind in blockName');
    }
};

type Exits = { blockName: string | false; next: boolean; exit: boolean };

const blockExits = (rtl: RTX[]): Exits => {
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
        case 'call':
        case 'push':
        case 'pop':
            return { blockName: false, next: true, exit: false };
        default:
            throw debug('Unrecognized RTX kind in blockExits');
    }
};

export const toDotFile = ({ blocks, connections, entry, exits }: ControlFlowGraph): string => {
    let dotText = 'digraph {\n';
    dotText += `Entry [style="invis"]\n`;
    dotText += `Entry -> ${entry}\n`;

    blocks.forEach(({ name, instructions }) => {
        const label = join([name, ...instructions.map(rtxToString)], '\\n')
            .replace(/"/g, '\\"')
            .replace(/:/g, '\\:');
        dotText += `${name} [shape="box", label="${label}"]`;
    });

    dotText += `Exit [style="invis"]\n`;
    exits.forEach(exit => {
        dotText += `${exit} -> Exit\n`;
    });
    connections.forEach(({ from, to }) => {
        dotText += `${from} -> ${to}\n`;
    });
    dotText += '}';
    return dotText;
};

export const controlFlowGraph = (rtl: RTX[]): ControlFlowGraph => {
    let blocks: BasicBlock[] = [];
    var currentBlock: RTX[] = [];
    rtl.forEach(rtx => {
        if (isBlockEnd(rtx)) {
            blocks.push({
                instructions: currentBlock,
                name: blockName(currentBlock),
            });
            currentBlock = [rtx];
        } else {
            currentBlock.push(rtx);
        }
    });
    blocks.push({
        instructions: currentBlock,
        name: blockName(currentBlock),
    });

    let connections: { from: string; to: string }[] = [];
    let exits: string[] = [];
    blocks.forEach((block, index) => {
        const { blockName, next, exit } = blockExits(block.instructions);
        if (blockName) {
            connections.push({ from: block.name, to: blockName });
        }
        if (next) {
            connections.push({ from: block.name, to: blocks[index + 1].name });
        }
        if (exit) {
            exits.push(block.name);
        }
    });

    return {
        blocks,
        connections,
        entry: blocks[0].name,
        exits,
    };
};
