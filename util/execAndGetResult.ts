import { exec } from 'child-process-promise';
import { ExecutionResult } from '../api.js';
export default async (command): Promise<ExecutionResult> => {
    try {
        const result = await exec(command);
        return {
            exitCode: 0,
            stdout: result.stdout as string,
        };
    } catch (e) {
        if (typeof e.code === 'number') {
            return {
                exitCode: e.code,
                stdout: e.stdout,
            };
        } else {
            return {
                error: `Couldn't get exit code: ${e}`
            };
        }
    }
};
