import { BackendInputs } from '../api.js';
import { exec } from 'child-process-promise';
import { file as tmpFile } from 'tmp-promise';
import execAndGetResult from '../util/execAndGetResult.js';

const sample = `
; ----------------------------------------------------------------------------------------
; Writes "Hello, World" to the console using only system calls. Runs on 64-bit macOS only.
; ----------------------------------------------------------------------------------------

          global    start

          section   .text
start:    mov       rax, 0x02000004         ; system call for write
          mov       rdi, 1                  ; file handle 1 is stdout
          mov       rsi, message            ; address of string to output
          mov       rdx, 13                 ; number of bytes
          syscall                           ; invoke operating system to do the write
          mov       rax, 0x02000001         ; system call for exit
          mov       rdi, 3                ; exit code 0
          syscall                           ; invoke operating system to exit

          section   .data
message:  db        "Hello, World", 10      ; note the newline at the end
`;

export default {
    name: 'x64',
    toExectuable: ({ functions, program, globalDeclarations, stringLiterals }: BackendInputs) => {
        return `
global start

section .text
start:
    mov rdi, 7; exit code
    mov rax, 0x02000001; system call for exit
    syscall

section .data
message:
    db "Must have writable segment", 10; newline mandatory. This exists to squelch dyld errors
`
    },
    execute: async path => {
        const linkerInputPath = await tmpFile({ postfix: '.o' });
        const exePath = await tmpFile({ postfix: '.out' });
        await exec(`nasm -fmacho64 -o ${linkerInputPath.path} ${path}`);
        await exec(`ld -o ${exePath.path} ${linkerInputPath.path}`);
        return execAndGetResult(exePath.path);
    },
}
