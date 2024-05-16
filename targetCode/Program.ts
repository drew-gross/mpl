import debug from '../util/debug';
import { toTarget as functionToTarget, Function } from './Function';
import { Function as ThreeAddressFunction } from '../threeAddressCode/Function';
import { Program as ThreeAddressProgram } from '../threeAddressCode/Program';
import { TargetInfo } from '../TargetInfo';

type ToTargetInput<TargetRegister> = {
    program: ThreeAddressProgram;
    targetInfo: TargetInfo<TargetRegister>;
    includeCleanup: boolean;
};

export type Program<TargetRegister> = {
    functions: Function<TargetRegister>[];
    main: Function<TargetRegister>;
};

export const toTarget = <TargetRegister>({
    program,
    includeCleanup,
    targetInfo,
}: ToTargetInput<TargetRegister>) => {
    const main = program.main;
    if (!main) throw debug('need a main');

    const mainFn: ThreeAddressFunction = {
        ...main,
        name: 'unused', // TODO: make name optional here
    };
    return {
        functions: program.functions.map(f =>
            functionToTarget({
                threeAddressFunction: f,
                targetInfo,
                finalCleanup: [{ kind: 'return', why: 'The Final Return!' }],
                isMain: false,
            })
        ),
        main: functionToTarget({
            threeAddressFunction: mainFn,
            // No need to save any registers in main, even if the target says to
            targetInfo: { ...targetInfo, extraSavedRegisters: [] },
            finalCleanup: [
                // TODO: push/pop exit code is jank and should be removed.
                {
                    kind: 'push',
                    register: targetInfo.registers.functionResult,
                    why: "Need to save exit code so it isn't clobbber by free_globals/verify_no_leaks",
                },
                ...(includeCleanup
                    ? [
                          {
                              kind: 'callByName' as 'callByName',
                              function: 'free_globals',
                              why: 'free_globals',
                          },
                          {
                              kind: 'callByName' as 'callByName',
                              function: 'verify_no_leaks',
                              why: 'verify_no_leaks',
                          },
                      ]
                    : []),
                {
                    kind: 'pop' as 'pop',
                    register: targetInfo.registers.syscallArgument[0],
                    why: 'restore exit code',
                },
                {
                    kind: 'loadImmediate' as 'loadImmediate',
                    destination: targetInfo.registers.syscallSelectAndResult,
                    value: targetInfo.registerAgnosticInfo.syscallNumbers.exit,
                    why: 'prepare to exit',
                },
                { kind: 'syscall' as 'syscall', why: 'exit' },
            ],
            isMain: true,
        }),
    };
};
