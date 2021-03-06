import ComparisonResult from './util/comparisonResult';
import debug from './util/debug';
import last from './util/list/last';
import { set, Set, join as setJoin, fromList as setFromList } from './util/set';
import { orderedSet, OrderedSet } from './util/ordered-set';
import join from './util/join';
import { RegisterAssignment } from './backend-utils';
import {
    Register,
    isEqual as registerIsEqual,
    compare as registerCompare,
} from './threeAddressCode/Register';
import { Function, toString as functionToString } from './threeAddressCode/Function';
functionToString; // tslint:disable-line
import {
    Statement,
    toString as tasToString,
    reads,
    writes,
    hasSideEffects,
    StackLocation,
} from './threeAddressCode/Statement';

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
        case 'alloca':
        case 'storeStack':
        case 'loadStack':
            return 'midBlock';
        case 'label':
        case 'functionLabel':
            return 'beginBlock';
        case 'return':
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
        case 'return':
            return { blockName: false, next: false, exit: true };
        case 'empty':
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
            throw debug('Unrecognized Statement kind in blockExits');
    }
};

export const toDotFile = ({ blocks, connections, exits }: ControlFlowGraph): string => {
    let dotText = 'digraph {\n';
    dotText += `Entry [style="invis"]\n`;
    dotText += `Entry -> node_0\n`;

    blocks.forEach(({ instructions }, index) => {
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
    const blocks: BasicBlock[] = [];
    let currentBlock: Statement[] = [];
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

    const labelToIndexMap = {};
    blocks.forEach((block, index) => {
        const firstRtx = block.instructions[0];
        if (firstRtx.kind == 'label' || firstRtx.kind == 'functionLabel') {
            labelToIndexMap[firstRtx.name] = index;
        }
    });

    const connections: { from: number; to: number }[] = [];
    const exits: number[] = [];
    blocks.forEach((block, index) => {
        const { blockName: exitedName, next, exit } = blockExits(block.instructions);
        if (exitedName) {
            connections.push({ from: index, to: labelToIndexMap[exitedName] });
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

// TODO: Args should not be necessary
export const computeBlockLiveness = (block: BasicBlock, args: Register[]): Set<Register>[] => {
    return block.instructions
        .slice()
        .reverse()
        .reduce(
            (liveness, next) => {
                const newLiveness = liveness[0].copy();
                const newlyLive = reads(next, args);
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
const propagateBlockLiveness = (
    block: BasicBlock,
    liveness: Set<Register>[],
    liveAtExit: Set<Register>
): boolean => {
    let changeEntry = false;
    liveAtExit.forEach(item => {
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
    // Block building results in the end of each block having the same last element as the first
    // item of the next block. Put the blocks together in a way that accounts for this. TODO: maybe
    // refactor the code so this isn't necessary?
    blocks.forEach((block, index) => {
        if (block.length == 0) debug('empty block');
        result.push(...block);
        if (index == blocks.length - 1) return;
        result.pop();
    });
    return result;
};

// TODO: Maybe treat function resuls specially somehow? Its kinda always live but that feels too special-casey.
export const tafLiveness = (taf: Function): Set<Register>[] => {
    const cfg = controlFlowGraph(taf.instructions);
    const blockLiveness = cfg.blocks.map(block => computeBlockLiveness(block, taf.arguments));
    const lastBlock = last(blockLiveness);
    if (lastBlock) {
        const lastStatementLiveness = last(lastBlock);
        if (lastStatementLiveness) {
            taf.liveAtExit.forEach(r => {
                lastStatementLiveness.add(r);
            });
        }
    }
    const remainingToPropagate: {
        entryLiveness: Set<Register>;
        index: number;
    }[] = blockLiveness.map((b, i) => ({
        entryLiveness: b[0],
        index: i,
    }));
    // TODO use drain()
    while (remainingToPropagate.length > 0) {
        const { entryLiveness, index } = remainingToPropagate.shift() as any;
        const preceedingNodeIndices = cfg.connections
            .filter(({ to }) => to == index)
            .map(n => n.from);
        preceedingNodeIndices.forEach(idx => {
            const changed = propagateBlockLiveness(
                cfg.blocks[idx],
                blockLiveness[idx],
                entryLiveness
            );
            if (changed) {
                remainingToPropagate.push({ entryLiveness: blockLiveness[idx][0], index: idx });
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
    localRegisters: OrderedSet<Register>;
    interferences: OrderedSet<RegisterInterference>;
};

const interferenceCompare = (
    lhs: RegisterInterference,
    rhs: RegisterInterference
): ComparisonResult => {
    const r1Comparison = registerCompare(lhs.r1, rhs.r1);
    if (r1Comparison != ComparisonResult.EQ) {
        return r1Comparison;
    }
    return registerCompare(lhs.r2, rhs.r2);
};

const interferenceInvolvesRegister = (
    interference: RegisterInterference,
    r: Register
): boolean => registerIsEqual(interference.r1, r) || registerIsEqual(interference.r2, r);

const otherRegister = (
    interference: RegisterInterference,
    r: Register
): Register | undefined => {
    if (registerIsEqual(interference.r1, r)) {
        return interference.r2;
    }
    if (registerIsEqual(interference.r2, r)) {
        return interference.r1;
    }
    return undefined;
};

export const registerInterferenceGraph = (
    liveness: Set<Register>[],
    argumentRegisters: Register[]
): RegisterInterferenceGraph => {
    const registerIsArgument = register =>
        argumentRegisters.some(arg => registerIsEqual(arg, register));
    const localRegisters = setJoin(registerIsEqual, liveness);
    localRegisters.removeWithPredicate(
        local => typeof local == 'string' || registerIsArgument(local)
    );
    const result: RegisterInterferenceGraph = {
        localRegisters: orderedSet(registerCompare),
        interferences: orderedSet(interferenceCompare),
    };
    liveness.forEach(registers => {
        registers.forEach(i => {
            registers.forEach(j => {
                if (typeof i != 'string' && typeof j != 'string') {
                    // We don't reuse arguments right now even if we could
                    if (registerIsArgument(i) || registerIsArgument(j)) {
                        return;
                    }
                    result.localRegisters.add(i);
                    result.localRegisters.add(j);
                    // Register always interfere with themselves, this doesn't need to be tracked
                    if (registerIsEqual(i, j)) {
                        return;
                    }
                    result.interferences.add({ r1: i, r2: j });
                }
            });
        });
    });
    return result;
};

// Put a stack read before every read of a variable, and a stack write after every write to it.
export const moveRegisterToStack = (
    taf: Function,
    register: Register,
    location: StackLocation
): Function => {
    if (typeof register == 'string') throw debug("Can't storeStack special registers");
    const newFunction: Function = { ...taf };
    newFunction.instructions = [];

    taf.instructions.forEach(instruction => {
        reads(instruction, taf.arguments).forEach(readRegister => {
            if (registerIsEqual(readRegister, register)) {
                newFunction.instructions.push({
                    kind: 'loadStack',
                    register: readRegister,
                    location,
                    why: 'loadStack',
                });
            }
        });
        newFunction.instructions.push(instruction);
        writes(instruction).forEach(writtenRegister => {
            if (registerIsEqual(writtenRegister, register)) {
                newFunction.instructions.push({
                    kind: 'storeStack',
                    register: writtenRegister,
                    location,
                    why: 'storeStack',
                });
            }
        });
    });

    return newFunction;
};

// Returns a new function if anything changed
export const removeDeadStores = (
    taf: Function,
    liveness: Set<Register>[]
): Function | undefined => {
    const newFunction: Function = { ...taf, instructions: [] };
    let anythingChanged: boolean = false;
    if (taf.instructions.length + 1 != liveness.length)
        throw debug('Liveness length != taf length + 1');
    for (let i = 0; i < taf.instructions.length; i++) {
        const currentInstruction = taf.instructions[i];
        // Any instruction with side effects needs to stay until we can prove that the side effects don't matter.
        if (hasSideEffects(currentInstruction)) {
            newFunction.instructions.push(currentInstruction);
            continue;
        }
        const targets = writes(currentInstruction);
        // If there are written registers and none of them are live, omit the write.
        // TODO: Treat function result and arguments less special-casey somehow. Maybe put it into liveness computing. NOTE: Writes to arguments are not dead because length is implemented in a way where the arguments are destroyed and repaired (TODO: verify this). TODO: probably should check if any target is a register?

        const isLiveWrite = targets.some(target => liveness[i + 1].has(target));
        if (isLiveWrite) {
            newFunction.instructions.push(taf.instructions[i]);
        } else {
            anythingChanged = true;
        }
    }
    if (!anythingChanged) {
        return undefined;
    }
    return newFunction;
};

export const assignRegisters = <TargetRegister>(
    taf: Function,
    colors: TargetRegister[],
    alreadySpilled: number = 0
): { assignment: RegisterAssignment<TargetRegister>; newFunction: Function } => {
    let liveness = tafLiveness(taf);
    let newFunction = removeDeadStores(taf, liveness);
    while (newFunction) {
        taf = newFunction;
        liveness = tafLiveness(taf);
        newFunction = removeDeadStores(taf, liveness);
    }

    // http://web.cecs.pdx.edu/~mperkows/temp/register-allocation.pdf
    const rig = registerInterferenceGraph(liveness, taf.arguments);
    const registersToAssign = rig.localRegisters.copy();
    const interferences = rig.interferences.copy();
    const colorableStack: Register[] = [];
    while (registersToAssign.size() > 0) {
        // We are looking for one node ...
        let colorableRegister = registersToAssign.extractOne(register => {
            // ... that we haven't already colored ...
            if (
                !colorableStack.every(
                    alreadyColored => !registerIsEqual(register, alreadyColored)
                )
            ) {
                return false;
            }

            // ... that interferes with a number of nodes ...
            let interferenceCount = 0;
            interferences.forEach(interference => {
                if (interferenceInvolvesRegister(interference, register)) {
                    interferenceCount++;
                }
            });

            // ... that is less than the number of available registers ...
            if (interferenceCount >= colors.length) {
                return false;
            }

            return true;
        });

        // ... or we choose a node to storeStack if we can't find one we can color ...
        if (!colorableRegister) {
            colorableRegister = registersToAssign.extractOne(_ => true);
        }

        if (!colorableRegister) {
            throw debug('Should have found a register of some sort.');
        }

        // ... and put it on the top of the colorable stack ...
        colorableStack.push(colorableRegister);

        // ... and remove it from the "to assign" list.
        interferences.removeWithPredicate(interference => {
            if (!colorableRegister) {
                throw debug('Should have found a register of some sort.');
            }
            return interferenceInvolvesRegister(interference, colorableRegister);
        });
        registersToAssign.remove(colorableRegister);
    }

    const result: RegisterAssignment<TargetRegister> = { registerMap: {}, spilled: [] };
    let needToSpill: undefined | Register = undefined;
    colorableStack.reverse().forEach(register => {
        if (needToSpill) return;
        // Try each color in order
        const color = colors.find(c => {
            // Check we if have a neighbour with this color already
            return rig.interferences.toList().every(interference => {
                const other = otherRegister(interference, register);
                if (!other) {
                    return true;
                }
                if (result.registerMap[(other as { name: string }).name] == c) {
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
        const spilled = moveRegisterToStack(taf, needToSpill, {
            kind: 'spill',
            slotNumber: alreadySpilled,
        });
        const spilledAssignment = assignRegisters(spilled, colors, alreadySpilled + 1);
        spilledAssignment.assignment.spilled.push(needToSpill);
        return spilledAssignment;
    }

    return { assignment: result, newFunction: taf };
};
