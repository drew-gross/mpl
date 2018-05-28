import * as open from 'opn';
import writeSvg from './writeSvg.js';
import { file as tmpFile } from 'tmp-promise';

export default async (dotText: string) => {
    const svgFile = await tmpFile({ postfix: '.svg' });
    await writeSvg(dotText, svgFile.path);
    await open(svgFile.path, { app: 'Google Chrome' });
};
