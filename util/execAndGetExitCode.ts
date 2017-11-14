import { exec } from 'child-process-promise';
export default async command => {
    try {
        await exec(command);
    } catch (e) {
        if (typeof e.code === 'number') {
            return e.code;
        } else {
            throw `Couldn't get exit code: ${e}`;
        }
    }
    return 0;
};
