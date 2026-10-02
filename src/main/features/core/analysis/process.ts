import { spawn } from 'node:child_process';

export interface ProcessResult {
    code: null | number;
    stderr: string;
    stdout: string;
}

/**
 * Spawn and collect both output streams. Aborting `signal` kills the child
 * with the platform default signal; the promise still settles on close.
 */
export function runProcess(
    binary: string,
    args: string[],
    signal?: AbortSignal,
): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, args, { signal, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
            stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stderr, stdout }));
    });
}
