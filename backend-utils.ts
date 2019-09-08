import join from './util/join.js';
import debug from './util/debug.js';
import { VariableDeclaration, ExecutionResult, Function, StringLiteralData, Backend } from './api.js';
import flatten from './util/list/flatten.js';
import { TargetThreeAddressStatement, ThreeAddressFunction } from './threeAddressCode/generator.js';
import tacToTarget from './threeAddressCode/toTarget.js';
import { Statement } from './threeAddressCode/statement.js';
import { Register, isEqual } from './register.js';
import { assignRegisters, controlFlowGraph } from './controlFlowGraph.js';

import mipsBackend from './backends/mips.js';
import jsBackend from './backends/js.js';
import cBackend from './backends/c.js';
import x64Backend from './backends/x64.js';

export type CompiledExpression<T> = {
    prepare: T[];
    execute: T[];
    cleanup: T[];
};

export type CompiledAssignment<T> = {
    prepare: T[];
    execute: T[];
    cleanup: T[];
};

export type CompiledProgram<T> = {
    prepare: T[];
    execute: T[];
    cleanup: T[];
};

type ExpressionCompiler<T> = (expressions: T[][]) => T[];
export const compileExpression = <T>(
    subExpressions: CompiledExpression<T>[],
    expressionCompiler: ExpressionCompiler<T>
): CompiledExpression<T> => ({
    prepare: flatten(subExpressions.map(input => input.prepare)),
    execute: expressionCompiler(subExpressions.map(input => input.execute)),
    cleanup: flatten(subExpressions.reverse().map(input => input.cleanup)),
});

export const stringLiteralName = ({ id, value }: StringLiteralData) =>
    `string_literal_${id}_${value.replace(/[^a-zA-Z]/g, '')}`;

export type RegisterAssignment<TargetRegister> = {
    registerMap: { [key: string]: TargetRegister };
    spilled: string[];
};

export const saveRegistersCode = <TargetRegister>(
    registerAssignment: RegisterAssignment<TargetRegister>
): TargetThreeAddressStatement<TargetRegister>[] =>
    Object.values(registerAssignment.registerMap).map(targetRegister => ({
        kind: 'push' as 'push',
        register: targetRegister,
        why: 'Push register to preserve it',
    }));

export const restoreRegistersCode = <TargetRegister>(
    registerAssignment: RegisterAssignment<TargetRegister>
): TargetThreeAddressStatement<TargetRegister>[] =>
    Object.values(registerAssignment.registerMap)
        .map(targetRegister => ({
            kind: 'pop' as 'pop',
            register: targetRegister,
            why: 'Restore preserved registers',
        }))
        .reverse();

export type RegisterDescription<TargetRegister> = {
    generalPurpose: TargetRegister[];
    functionArgument: TargetRegister[];
    functionResult: TargetRegister;
    syscallArgument: TargetRegister[];
    syscallSelectAndResult: TargetRegister;
};

const getRegisterFromAssignment = <TargetRegister>(
    registerAssignment: RegisterAssignment<TargetRegister>,
    argumentRegisters: Register[], // TODO Maybe put the info about whether the register is an argument directly into the register?
    specialRegisters: RegisterDescription<TargetRegister>,
    r: Register
): TargetRegister => {
    let argIndex = argumentRegisters.findIndex(arg => isEqual(arg, r));
    if (typeof r == 'string') {
        // TODO: remove "result" hack register
        if (r != 'result') debug('bad register');
        return specialRegisters.functionResult;
    } else if (argIndex > -1) {
        // It's an argument!
        if (argIndex < specialRegisters.functionArgument.length) {
            return specialRegisters.functionArgument[argIndex];
        } else {
            throw debug('Need to load from stack I guess?');
        }
    } else {
        if (!(r.name in registerAssignment.registerMap)) {
            throw debug(
                `couldnt find an assignment for register: ${r.name}. Map: ${JSON.stringify(
                    registerAssignment.registerMap
                )}`
            );
        }
        return registerAssignment.registerMap[r.name];
    }
    throw debug('should not get here');
};

type RtlToTargetInput<TargetRegister> = {
    threeAddressFunction: ThreeAddressFunction;
    makePrologue: (a: RegisterAssignment<TargetRegister>) => TargetThreeAddressStatement<TargetRegister>[];
    makeEpilogue: (a: RegisterAssignment<TargetRegister>) => TargetThreeAddressStatement<TargetRegister>[];
    registers: RegisterDescription<TargetRegister>;
    syscallNumbers: any;
    instructionTranslator: (t: TargetThreeAddressStatement<TargetRegister>) => string[];
    registersClobberedBySyscall: TargetRegister[];
};
export const rtlToTarget = <TargetRegister>({
    threeAddressFunction,
    registers,
    syscallNumbers,
    instructionTranslator,
    makePrologue,
    makeEpilogue,
    registersClobberedBySyscall,
}: RtlToTargetInput<TargetRegister>): string => {
    const { assignment, newFunction } = assignRegisters(threeAddressFunction, registers.generalPurpose);

    const stackOffsetPerInstruction: number[] = [];
    let totalStackBytes: number = 0;
    newFunction.instructions.forEach(i => {
        if (i.kind == 'alloca') {
            totalStackBytes += i.bytes;
            stackOffsetPerInstruction.push(i.bytes);
        } else {
            stackOffsetPerInstruction.push(0);
        }
    });

    const statements: TargetThreeAddressStatement<TargetRegister>[] = flatten(
        newFunction.instructions.map((instruction, index) =>
            tacToTarget(
                instruction,
                stackOffsetPerInstruction[index],
                syscallNumbers,
                registers,
                r => getRegisterFromAssignment(assignment, threeAddressFunction.arguments, registers, r),
                registersClobberedBySyscall
            )
        )
    );

    const wholeFunction = [...makePrologue(assignment), ...statements, ...makeEpilogue(assignment)];
    return join(flatten(wholeFunction.map(instructionTranslator)), '\n');
};

export const backends: Backend[] = [mipsBackend, jsBackend, cBackend, x64Backend];
