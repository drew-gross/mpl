import debug from './util/debug.js';
import last from './util/list/last.js';
import sum from './util/list/sum.js';
import flatten from './util/list/flatten.js';
import { set, Set, join as setJoin, fromList as setFromList } from './util/set.js';
import { filter, FilterPredicate } from './util/list/filter.js';
import join from './util/join.js';
import grid from './util/grid.js';
import { RegisterAssignment } from './backend-utils.js';
import { Register, isEqual as registerIsEqual } from './register.js';
import { ThreeAddressStatement, ThreeAddressFunction } from './threeAddressCode/generator.js';
import tasToString from './threeAddressCode/statementToString.js';
import { Graph } from 'graphlib';

export type BasicBlock = {
    name: string;
    instructions: ThreeAddressStatement[];
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

const blockBehaviour = (tas: ThreeAddressStatement): 'endBlock' | 'beginBlock' | 'midBlock' => {
    switch (tas.kind) {
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
        case 'stackAllocateAndStorePointer':
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
            throw debug(`${(tas as any).kind} unhanldes in blockBehaviour`);
    }
};

const livenessUpdate = (tas: ThreeAddressStatement): { newlyLive: Register[]; newlyDead: Register[] } => {
    switch (tas.kind) {
        case 'comment':
            return { newlyLive: [], newlyDead: [] };
        case 'syscall':
            const predicate: FilterPredicate<Register | number, Register> = (arg: Register | number): arg is Register =>
                typeof arg !== 'number';
            const registerArguments: Register[] = filter<Register | number, Register>(tas.arguments, predicate);
            return {
                newlyLive: registerArguments,
                newlyDead: tas.destination ? [tas.destination] : [],
            };
        case 'move':
            return { newlyLive: [tas.from], newlyDead: [tas.to] };
        case 'loadImmediate':
            return { newlyLive: [], newlyDead: [tas.destination] };
        case 'addImmediate':
        case 'increment':
            return { newlyLive: [tas.register], newlyDead: [] };
        case 'subtract':
        case 'add':
        case 'multiply':
            return { newlyLive: [tas.lhs, tas.rhs], newlyDead: [tas.destination] };
        case 'storeGlobal':
            return { newlyLive: [tas.from], newlyDead: [] };
        case 'loadGlobal':
            return { newlyLive: [], newlyDead: [tas.to] };
        case 'storeMemory':
            return { newlyLive: [tas.from, tas.address], newlyDead: [] };
        case 'storeMemoryByte':
            return { newlyLive: [tas.contents, tas.address], newlyDead: [] };
        case 'storeZeroToMemory':
            return { newlyLive: [tas.address], newlyDead: [] };
        case 'loadMemory':
            return { newlyLive: [tas.from], newlyDead: [tas.to] };
        case 'loadMemoryByte':
            return { newlyLive: [tas.address], newlyDead: [tas.to] };
        case 'loadSymbolAddress':
            return { newlyLive: [], newlyDead: [tas.to] };
        case 'callByRegister':
            return { newlyLive: [tas.function], newlyDead: [] };
        case 'label':
        case 'callByName':
        case 'functionLabel':
        case 'returnToCaller':
        case 'goto':
            return { newlyLive: [], newlyDead: [] };
        case 'gotoIfEqual':
        case 'gotoIfNotEqual':
        case 'gotoIfGreater':
            const live = [tas.lhs];
            if (typeof tas.rhs != 'number') {
                live.push(tas.rhs);
            }
            return { newlyLive: live, newlyDead: [] };
        case 'gotoIfZero':
            return { newlyLive: [tas.register], newlyDead: [] };
        case 'stackAllocateAndStorePointer':
            return { newlyLive: [], newlyDead: [tas.register] };
        default:
            throw debug(`${(tas as any).kind} unhanldes in livenessUpdate`);
    }
};

const blockName = (rtl: ThreeAddressStatement[]) => {
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

const blockExits = (rtl: ThreeAddressStatement[]): Exits => {
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
            return { blockName: false, next: true, exit: false };
        default:
            throw debug('Unrecognized ThreeAddressStatement kind in blockExits');
    }
};

export const toDotFile = ({ blocks, connections, labelToIndexMap, exits }: ControlFlowGraph): string => {
    let dotText = 'digraph {\n';
    dotText += `Entry [style="invis"]\n`;
    dotText += `Entry -> node_0\n`;

    blocks.forEach(({ name, instructions }, index) => {
        const label = join(instructions.map(tasToString), '\\n')
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

export const controlFlowGraph = (rtl: ThreeAddressStatement[]): ControlFlowGraph => {
    let blocks: BasicBlock[] = [];
    var currentBlock: ThreeAddressStatement[] = [];
    rtl.forEach(rtx => {
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

export const computeBlockLiveness = (block: BasicBlock): Set<Register>[] => {
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
    let changeEntry = false;
    liveAtExit.toList().forEach(item => {
        for (let i = liveness.length - 1; i >= 0; i--) {
            if (i < block.instructions.length) {
                const newlyDead = setFromList(registerIsEqual, livenessUpdate(block.instructions[i]).newlyDead);
                if (newlyDead.has(item)) {
                    return;
                }
            }
            if (i == 0 && !liveness[i].has(item)) {
                changeEntry = true;
            }
            liveness[i].add(item);
        }
    });
    return changeEntry;
};

const verifyingOverlappingJoin = (blocks: Set<Register>[][]): Set<Register>[] => {
    const result: Set<Register>[] = [];
    blocks.forEach((block, index) => {
        if (index == blocks.length - 1) return;
        const nextBlock = blocks[index + 1];
        const lastOfCurrent = last(block);
        if (!lastOfCurrent) throw debug('empty block');
        const firstOfNext = nextBlock[0];
    });
    blocks.forEach((block, index) => {
        result.push(...block);
        if (index == blocks.length - 1) return;
        result.pop();
    });
    return result;
};

export const tafLiveness = (taf: ThreeAddressFunction): Set<Register>[] => {
    const cfg = controlFlowGraph(taf.instructions);
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
    const overallLiveness: Set<Register>[] = verifyingOverlappingJoin(blockLiveness);
    if (taf.instructions.length + 1 != overallLiveness.length) {
        throw debug('overallLiveness length mimatch');
    }
    return overallLiveness;
};

type RegisterInterference = { r1: Register; r2: Register };

export type RegisterInterferenceGraph = {
    nonSpecialRegisters: Set<Register>;
    interferences: Set<RegisterInterference>;
};

const interferenceIsEqual = (lhs: RegisterInterference, rhs: RegisterInterference): boolean => {
    if (registerIsEqual(lhs.r1, rhs.r1) && registerIsEqual(lhs.r2, rhs.r2)) {
        return true;
    }
    if (registerIsEqual(lhs.r1, rhs.r2) && registerIsEqual(lhs.r2, rhs.r1)) {
        return true;
    }
    return false;
};

const interferenceInvolvesRegister = (interference: RegisterInterference, r: Register): boolean =>
    registerIsEqual(interference.r1, r) || registerIsEqual(interference.r2, r);

const otherRegister = (interference: RegisterInterference, r: Register): Register | undefined => {
    if (registerIsEqual(interference.r1, r)) {
        return interference.r2;
    }
    if (registerIsEqual(interference.r2, r)) {
        return interference.r1;
    }
    return undefined;
};

export const registerInterferenceGraph = (liveness: Set<Register>[]): RegisterInterferenceGraph => {
    const nonSpecialRegisters = setJoin(registerIsEqual, liveness);
    nonSpecialRegisters.removeWithPredicate(item => typeof item == 'string');
    const result: RegisterInterferenceGraph = {
        nonSpecialRegisters: set(registerIsEqual),
        interferences: set(interferenceIsEqual),
    };
    liveness.forEach(registers => {
        registers.toList().forEach(i => {
            registers.toList().forEach(j => {
                if (typeof i != 'string' && typeof j != 'string') {
                    result.nonSpecialRegisters.add(i);
                    result.nonSpecialRegisters.add(j);
                    if (!registerIsEqual(i, j)) {
                        result.interferences.add({ r1: i, r2: j });
                    }
                }
            });
        });
    });
    return result;
};

export const assignRegisters = <TargetRegister>(
    taf: ThreeAddressFunction,
    colors: TargetRegister[]
): RegisterAssignment<TargetRegister> => {
    const liveness = tafLiveness(taf);
    const rig = registerInterferenceGraph(liveness);
    const registersToAssign = rig.nonSpecialRegisters.copy();
    const interferences = rig.interferences.copy();
    const colorableStack: Register[] = [];
    while (colorableStack.length < rig.nonSpecialRegisters.size()) {
        let stackGrew = false;
        rig.nonSpecialRegisters.toList().forEach(register => {
            if (stackGrew) {
                return;
            }
            if (!colorableStack.every(alreadyColored => !registerIsEqual(register, alreadyColored))) {
                return;
            }
            let interferenceCount = 0;
            interferences.toList().forEach(interference => {
                if (interferenceInvolvesRegister(interference, register)) {
                    interferenceCount++;
                }
            });
            if (interferenceCount < colors.length) {
                colorableStack.push(register);
                stackGrew = true;
                interferences.removeWithPredicate(interference => interferenceInvolvesRegister(interference, register));
                registersToAssign.remove(register);
            }
        });
        if (!stackGrew) {
            throw debug('would spill - not implemented yet');
        }
    }

    const result: RegisterAssignment<TargetRegister> = {};
    colorableStack.reverse().forEach(register => {
        // Try each color in order
        const color = colors.find(color => {
            // Check we if have a neighbour with this color already
            return rig.interferences.toList().every(interference => {
                const other = otherRegister(interference, register);
                if (!other) {
                    return true;
                }
                if (result[(other as { name: string }).name] == color) {
                    return false;
                }
                return true;
            });
        });
        if (!color) throw debug("couldn't find a color to assign");
        result[(register as { name: string }).name] = color;
    });

    return result;
};
