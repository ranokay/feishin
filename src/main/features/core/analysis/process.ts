import { spawn } from 'node:child_process';

/** One ffmpeg metadata pass prints per-frame lines; cap what we retain. */
const MAX_OUTPUT_CHARS = 16 * 1024 * 1024;

export interface ProcessResult {
    code: null | number;
    stderr: string;
    stdout: string;
}

/**
 * Spawn and collect both output streams. Aborting `signal` kills the child;
 * the promise still settles on close, and spawn/stream failures reject.
 * Output beyond MAX_OUTPUT_CHARS keeps the tail (ffmpeg prints its summaries
 * at the end) so a pathological file cannot grow memory without bound.
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
        child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
            stdout = appendCapped(stdout, chunk);
        });
        child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
            stderr = appendCapped(stderr, chunk);
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stderr, stdout }));
    });
}

function appendCapped(current: string, chunk: string): string {
    const combined = current + chunk;
    return combined.length <= MAX_OUTPUT_CHARS
        ? combined
        : combined.slice(combined.length - MAX_OUTPUT_CHARS);
}
