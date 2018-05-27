import * as open from 'opn';
import { exec } from 'child-process-promise';
import { file as tmpFile } from 'tmp-promise';
import { writeFile } from 'fs-extra';

export default async (dotText: string) => {
    const dotFile = await tmpFile({ postfix: '.dot' });
    const svgFile = await tmpFile({ postfix: '.svg' });
    await writeFile(dotFile.fd, dotText);
    console.log(dotText);
    await exec(`dot -Tsvg -o${svgFile.path} ${dotFile.path}`);
    await open(svgFile.path, { app: 'Google Chrome' });
};
