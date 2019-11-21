import debug from '../debug.js';
import { exec } from 'child-process-promise';
import { file as tmpFile } from 'tmp-promise';
import { writeFile, ensureFile } from 'fs-extra';

// returns the path to the svg
export default async (
    dotText: string,
    svgPath: string,
    engine: string = 'dot'
): Promise<void> => {
    const dotFile = await tmpFile({ postfix: '.dot' });
    await writeFile(dotFile.fd, dotText);
    await ensureFile(svgPath);
    try {
        await exec(`${engine} -Tsvg -o${svgPath} ${dotFile.path}`);
    } catch (e) {
        debug(`${engine} failed`);
    }
    return;
};
