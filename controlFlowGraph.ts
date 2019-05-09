import debug from './util/debug.js';
import last from './util/list/last.js';
import sum from './util/list/sum.js';
import flatten from './util/list/flatten.js';
import { set, Set, join as setJoin, fromList as setFromList } from './util/set.js';
import join from './util/join.js';
import grid from './util/grid.js';
import idAppender from './util/idAppender.js';
import { RegisterAssignment } from './backend-utils.js';
import { Register, isEqual as registerIsEqual } from './register.js';
import { ThreeAddressFunction } from './threeAddressCode/generator.js';
import { Statement, toString as tasToString, reads, writes } from './threeAddressCode/statement.js';
import { Graph } from 'graphlib';
import { functionToString } from './threeAddressCode/programToString.js';

export type BasicBlock = {
    name: string;
    instructions: Statement[];
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

const blockBehaviour = (tas: Statement): 'endBlock' | 'beginBlock' | 'midBlock' => {
    switch (tas.kind) {
        case 'empty':
        case 'syscallWithResult':
        case 'syscallWithoutResult':
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
        case 'spill':
        case 'unspill':
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

const blockName = (rtl: Statement[]) => {
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

const blockExits = (rtl: Statement[]): Exits => {
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
        case 'empty':
        case 'syscallWithResult':
        case 'syscallWithoutResult':
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
            throw debug('Unrecognized Statement kind in blockExits');
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

export const controlFlowGraph = (rtl: Statement[]): ControlFlowGraph => {
    let blocks: BasicBlock[] = [];
    var currentBlock: Statement[] = [];
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
                const newlyLive = reads(next);
                const newlyDead = writes(next);
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
                const newlyDead = setFromList(registerIsEqual, writes(block.instructions[i]));
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
    // TODO: what is this forEach even doing?
    blocks.forEach((block, index) => {
        if (index == blocks.length - 1) return;
        const nextBlock = blocks[index + 1];
        const lastOfCurrent = last(block);
        if (!lastOfCurrent) throw debug('empty block');
        const firstOfNext = nextBlock[0];
    });
    // Block building results in the end of each block having the same last element as the first
    // item of the next block. Put the blocks together in a way that accounts for this. TODO: maybe
    // refactor the code so this isn't necessary?
    blocks.forEach((block, index) => {
        result.push(...block);
        if (index == blocks.length - 1) return;
        result.pop();
    });
    return result;
};

// TODO: Maybe treat function resuls specially somehow? Its kinda always live but that feels too special-casey.
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

export const spill = (taf: ThreeAddressFunction, registerToSpill: Register): ThreeAddressFunction => {
    if (typeof registerToSpill == 'string') throw debug("Can't spill special registers");
    const currentSpillIndex = taf.spills + 1;
    const registerName = idAppender();
    const newFunction: ThreeAddressFunction = { instructions: [], spills: currentSpillIndex, name: taf.name };

    // When we spill a register, we replace every read of that register with an unspill to a new register that
    // exists only as long as that read, and replace every write the write followed by a spill, so that the
    // lifetime of the spilled register is very short. Each read or write needs to create a new register to spill
    // from or to (we call that register a fragment) and this function creates a new fragment for each read/write.
    const makeFragment = () => ({ name: registerName(`${registerToSpill.name}_spill`) });

    taf.instructions.forEach(instruction => {
        switch (instruction.kind) {
            case 'empty': {
                newFunction.instructions.push(instruction);
                break;
            }
            case 'loadImmediate': {
                // TODO: seems weird to spill in this case? Could just reload instead. Oh well, will fix later.
                if (registerIsEqual(instruction.destination, registerToSpill)) {
                    const fragment = makeFragment();
                    newFunction.instructions.push({
                        ...instruction,
                        destination: fragment,
                    });
                    newFunction.instructions.push({
                        kind: 'spill',
                        register: fragment,
                        offset: currentSpillIndex,
                        why: 'spill',
                    });
                } else {
                    newFunction.instructions.push(instruction);
                }
                break;
            }
            case 'add':
            case 'multiply': {
                let newLhs = instruction.lhs;
                let newRhs = instruction.rhs;
                if (registerIsEqual(instruction.lhs, registerToSpill)) {
                    newLhs = makeFragment();
                    newFunction.instructions.push({
                        kind: 'unspill',
                        register: newLhs,
                        offset: currentSpillIndex,
                        why: 'unspill',
                    });
                }
                if (registerIsEqual(instruction.rhs, registerToSpill)) {
                    newRhs = makeFragment();
                    newFunction.instructions.push({
                        kind: 'unspill',
                        register: newRhs,
                        offset: currentSpillIndex,
                        why: 'unspill',
                    });
                }
                let newDestination = instruction.destination;
                if (registerIsEqual(instruction.destination, registerToSpill)) {
                    newDestination = makeFragment();
                    newFunction.instructions.push({
                        ...instruction,
                        lhs: newLhs,
                        rhs: newRhs,
                        destination: newDestination,
                    });
                    newFunction.instructions.push({
                        kind: 'spill',
                        register: newDestination,
                        offset: currentSpillIndex,
                        why: 'spill',
                    });
                } else {
                    newFunction.instructions.push({
                        ...instruction,
                        lhs: newLhs,
                        rhs: newRhs,
                    });
                }
                break;
            }
            case 'move': {
                // TODO: seems weird to spill a move. Maybe should _replace_ the move or sommething?
                let newSource = instruction.from;
                if (registerIsEqual(instruction.from, registerToSpill)) {
                    newSource = makeFragment();
                    newFunction.instructions.push({
                        kind: 'unspill',
                        register: newSource,
                        offset: currentSpillIndex,
                        why: 'unspill',
                    });
                }
                if (registerIsEqual(instruction.to, registerToSpill)) {
                    let newDestination = makeFragment();
                    newFunction.instructions.push({
                        ...instruction,
                        to: newDestination,
                        from: newSource,
                    });
                    newFunction.instructions.push({
                        kind: 'spill',
                        register: newDestination,
                        offset: currentSpillIndex,
                        why: 'spill',
                    });
                } else {
                    newFunction.instructions.push({
                        ...instruction,
                        from: newSource,
                    });
                }
                break;
            }
            case 'unspill':
            case 'spill':
                if (registerIsEqual(instruction.register, registerToSpill)) {
                    throw debug('repsill');
                }
            case 'syscallWithResult':
            case 'syscallWithoutResult':
            case 'callByName': {
                newFunction.instructions.push(instruction);
                break;
            }
            case 'loadSymbolAddress':
                if (registerIsEqual(instruction.to, registerToSpill)) {
                    let newDestination = makeFragment();
                    newFunction.instructions.push({
                        ...instruction,
                        to: newDestination,
                    });
                    newFunction.instructions.push({
                        kind: 'spill',
                        register: newDestination,
                        offset: currentSpillIndex,
                        why: 'spill',
                    });
                } else {
                    newFunction.instructions.push(instruction);
                }
                break;
            default:
                if (reads(instruction).includes(registerToSpill) || writes(instruction).includes(registerToSpill)) {
                    throw debug(`${instruction.kind} unhandled in spill`);
                } else {
                    newFunction.instructions.push(instruction);
                }
        }
    });

    return newFunction;
};

// Returns a new function if anything changed
const removeDeadStores = (taf: ThreeAddressFunction, liveness: Set<Register>[]): ThreeAddressFunction | undefined => {
    const newFunction: ThreeAddressFunction = { ...taf, instructions: [] };
    let anythingChanged: boolean = false;
    if (taf.instructions.length + 1 != liveness.length) throw debug('Liveness length != taf length + 1');
    for (let i = 0; i < taf.instructions.length; i++) {
        const targets = writes(taf.instructions[i]);
        // If there are written registers and none of them are live, omit the write. This
        // will fail if the instruction doing the writing also has side effects, e.g. syscall. TODO:
        // Implement something that takes this into account. TODO: Treat function result and arguments less special-casey somehow. Maybe put it into liveness computing. NOTE: Writes to arguments are not dead because length is implemented in a way where the arguments are destroyed and repaired.
        if (
            targets.length == 0 ||
            registerIsEqual(targets[0], 'result') ||
            registerIsEqual(targets[0], 'arg1') ||
            registerIsEqual(targets[0], 'arg2') ||
            registerIsEqual(targets[0], 'arg3')
        ) {
            newFunction.instructions.push(taf.instructions[i]);
        } else if (targets.length == 1) {
            const isLiveWrite = liveness[i + 1].has(targets[0]);
            if (isLiveWrite) {
                newFunction.instructions.push(taf.instructions[i]);
            } else {
                anythingChanged = true;
            }
        } else {
            throw debug('instructions with more than one target not supported');
        }
    }
    if (!anythingChanged) {
        return undefined;
    }
    return newFunction;
};

export const assignRegisters = <TargetRegister>(
    taf: ThreeAddressFunction,
    colors: TargetRegister[]
): { assignment: RegisterAssignment<TargetRegister>; newFunction: ThreeAddressFunction } => {
    let liveness = tafLiveness(taf);
    let newFunction: undefined | ThreeAddressFunction = undefined;
    while ((newFunction = removeDeadStores(taf, liveness))) {
        taf = newFunction;
        liveness = tafLiveness(taf);
    }

    const rig = registerInterferenceGraph(liveness);
    const registersToAssign = rig.nonSpecialRegisters.copy();
    const interferences = rig.interferences.copy();
    const colorableStack: Register[] = [];
    while (registersToAssign.size() > 0) {
        let stackGrew = false;
        registersToAssign.toList().forEach(register => {
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

    const result: RegisterAssignment<TargetRegister> = { registerMap: {}, spilled: [] };
    let needToSpill: undefined | Register = undefined;
    colorableStack.reverse().forEach(register => {
        if (needToSpill) return;
        // Try each color in order
        const color = colors.find(color => {
            // Check we if have a neighbour with this color already
            return rig.interferences.toList().every(interference => {
                const other = otherRegister(interference, register);
                if (!other) {
                    return true;
                }
                if (result.registerMap[(other as { name: string }).name] == color) {
                    return false;
                }
                return true;
            });
        });
        if (!color && !(typeof register === 'string')) {
            needToSpill = register;
            return;
        } else if (!color) {
            throw debug('no color found for special register???');
        }
        if (!register) throw debug('invalid register');
        result.registerMap[(register as { name: string }).name] = color;
    });

    if (needToSpill) {
        const spilled = spill(taf, needToSpill);
        return assignRegisters(spilled, colors);
    }

    return { assignment: result, newFunction: taf };
};
