import { exec } from 'child-process-promise';
export default async (
    command: string
): Promise<{ exitCode: number; stdout: string; stderr: string } | { error: string }> => {
    try {
        const result = await exec(command);
        return { exitCode: 0, stdout: result.stdout as string, stderr: result.stderr };
    } catch (e) {
        if (typeof e.code === 'number') {
            return { exitCode: e.code, stdout: e.stdout, stderr: e.stderr };
        } else {
            return { error: `Couldn't get exit code: ${e}` };
        }
    }
};
