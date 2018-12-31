import { file as tmpFile } from 'tmp-promise';
import { writeFile, FileResult } from 'fs-extra';

// Write the provided contents to a temporary file with the provided extension. Return the created file object.
export default async (contents: string, extension: string): Promise<FileResult> => {
    const file = await tmpFile({ postfix: extension });
    await writeFile(file.fd, contents);
    return file;
};
