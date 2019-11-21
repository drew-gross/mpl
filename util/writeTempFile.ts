import { file as tmpFile } from 'tmp-promise';
import { writeFile, FileResult } from 'fs-extra';

// Write the provided contents to a temporary file with the provided extension. Return the created file object.
export default async (
    contents: string,
    name: string,
    extension: string
): Promise<FileResult> => {
    const file = await tmpFile({ template: `${name}-XXXXXX.${extension}`, dir: '/tmp' });
    await writeFile(file.fd, contents);
    return file;
};
