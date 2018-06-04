import debug from './util/debug.js';
import last from './util/list/last.js';
import { filter, FilterPredicate } from './util/list/filter.js';
import join from './util/join.js';
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

type Set<T> = {
    add: (item: T) => void;
    addUnique: (item: T) => void;
    remove: (item: T) => void;
    has: (item: T) => boolean;
    copy: () => Set<T>;
    toList: () => T[];
    isSubsetOf: (other: Set<T>) => boolean;
    isEqual: (other: Set<T>) => boolean;
};

const set = <T>(isEqual: (lhs: T, rhs: T) => boolean): Set<T> => {
    const data: T[] = [];
    const self = {
        // Add an item to the set if it is not equal to any existing items
        add: (item: T) => {
            if (data.every(existing => !isEqual(existing, item))) {
                data.push(item);
            }
        },
        remove: item => {
            const index = data.findIndex(existing => isEqual(item, existing));
            if (index != -1) {
                data.splice(index, 1);
            }
        },
        // If you have external knowledge that the item is not already in the set,
        // you can add it unconditionally using this method
        addUnique: item => {
            data.push(item);
        },
        // Check if an item is in the set
        has: item => data.some(existing => isEqual(existing, item)),
        // Copy the set
        copy: () => {
            const copy = set(isEqual);
            data.forEach(item => copy.addUnique(item));
            return copy;
        },
        toList: () => data.slice(),
        // TODO: Type system should ban comparisons of sets with different isEqual
        isSubsetOf: (other: Set<T>) => {
            return data.every(item => other.has(item));
        },
        isEqual: (other: Set<T>) => {
            return self.isSubsetOf(other) && other.isSubsetOf(self);
        },
    };
    return self;
};

export const computeLiveness = (block: BasicBlock) => {
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

export const assignRegisters = (rtlf: RTLF): RegisterAssignment => {
    const cfg = controlFlowGraph(rtlf);
    const livenessAfterCodepointsByBlock = cfg.blocks.map(computeLiveness);
    return {}; //TODO
};
