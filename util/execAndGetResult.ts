import { exec } from 'child-process-promise';
import { ExecutionResult } from '../api.js';
export default async (executorName: string, command: string): Promise<ExecutionResult> => {
    try {
        const result = await exec(command);
        return { exitCode: 0, stdout: result.stdout as string, executorName };
    } catch (e) {
        if (typeof e.code === 'number') {
            return { exitCode: e.code, stdout: e.stdout, executorName };
        } else {
            return { error: `Couldn't get exit code: ${e}`, executorName };
        }
    }
};
