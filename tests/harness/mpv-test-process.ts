import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export interface MpvResponse {
    data?: unknown;
    error: string;
    request_id?: number;
}

export interface WaitForOptions {
    name: string;
    timeoutMs?: number;
    where?: (payload: Record<string, unknown>) => boolean;
}

interface MpvEvent {
    [name: string]: unknown;
    event?: string;
}

interface PendingRequest {
    reject: (reason: Error) => void;
    resolve: (response: MpvResponse) => void;
    timer: NodeJS.Timeout;
}

const DEFAULT_START_TIMEOUT_MS = 15000;
const DEFAULT_REQUEST_TIMEOUT_MS = 8000;

export class MpvTestProcess {
    public readonly socketPath: string;

    private buffer = '';

    private eventHistory: MpvEvent[] = [];
    private eventWaiters: Array<{
        options: WaitForOptions;
        resolve: (payload: Record<string, unknown>) => void;
        timer: NodeJS.Timeout;
    }> = [];
    private nextRequestId = 1;
    private pending = new Map<number, PendingRequest>();
    private processRef: null | ReturnType<typeof spawn> = null;
    private socket: net.Socket | null = null;
    private stderrOutput = '';
    constructor(private readonly options: { args?: string[]; binaryPath?: string } = {}) {
        this.socketPath = this.createSocketPath();
    }
    static async isAvailable(): Promise<boolean> {
        return new Promise((resolve) => {
            const child = spawn(MpvTestProcess.resolveBinaryPath(), ['--version'], {
                stdio: 'ignore',
            });
            child.on('error', () => resolve(false));
            child.on('exit', (code) => resolve(code === 0));
        });
    }

    static resolveBinaryPath(): string {
        return process.env.FEISHIN_TEST_MPV_BINARY ?? 'mpv';
    }

    async dispose(): Promise<void> {
        try {
            await this.request(['quit']);
        } catch {
            this.processRef?.kill('SIGKILL');
        }
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                this.processRef?.kill('SIGKILL');
                resolve();
            }, 3000);
            if (!this.processRef) {
                clearTimeout(timer);
                resolve();
                return;
            }
            this.processRef.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
        });
        this.socket?.destroy();
    }

    events(): readonly MpvEvent[] {
        return this.eventHistory;
    }

    async getProperty(name: string): Promise<unknown> {
        const response = await this.request(['get_property', name]);
        if (response.error !== 'success') {
            throw new Error(`get_property ${name} failed: ${response.error}`);
        }
        return response.data;
    }

    async observe(id: number, name: string): Promise<MpvResponse> {
        return this.request(['observe_property', id, name]);
    }

    async request(
        command: unknown[],
        timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    ): Promise<MpvResponse> {
        if (!this.socket || !this.socket.writable) {
            throw new Error('mpv IPC socket is not connected');
        }
        const requestId = this.nextRequestId++;
        return new Promise<MpvResponse>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(
                    new Error(
                        `request ${requestId} timed out after ${timeoutMs}ms: ${JSON.stringify(command)}`,
                    ),
                );
            }, timeoutMs);
            this.pending.set(requestId, { reject, resolve, timer });
            this.socket!.write(`${JSON.stringify({ command, request_id: requestId })}\n`);
        });
    }

    async setProperty(name: string, value: unknown): Promise<void> {
        const response = await this.request(['set_property', name, value]);
        if (response.error !== 'success') {
            throw new Error(`set_property ${name} failed: ${response.error}`);
        }
    }

    async start(startTimeoutMs = DEFAULT_START_TIMEOUT_MS): Promise<void> {
        const binaryPath = this.options.binaryPath ?? MpvTestProcess.resolveBinaryPath();
        const args = [
            '--no-config',
            '--idle=yes',
            '--really-quiet',
            `--input-ipc-server=${this.socketPath}`,
            ...(this.options.args ?? []),
        ];

        this.processRef = spawn(binaryPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        this.processRef.stderr?.on('data', (chunk: Buffer) => {
            this.stderrOutput += chunk.toString();
        });
        this.processRef.on('exit', () => {
            for (const [id, pending] of this.pending.entries()) {
                clearTimeout(pending.timer);
                pending.reject(new Error(`mpv exited while request ${id} was in flight`));
                this.pending.delete(id);
            }
        });

        await this.waitForSocket(startTimeoutMs);
        this.attachSocket();
    }

    async waitFor(options: WaitForOptions): Promise<Record<string, unknown>> {
        const match = this.eventHistory.find((event) => matches(event, options));
        if (match) {
            return match as Record<string, unknown>;
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.eventWaiters = this.eventWaiters.filter((waiter) => waiter.timer !== timer);
                reject(
                    new Error(
                        `timed out waiting for ${options.name} after ${options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS}ms; saw events: ${this.eventHistory
                            .map((e) => String(e.event))
                            .join(',')}`,
                    ),
                );
            }, options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
            this.eventWaiters.push({ options, resolve, timer });
        });
    }

    private attachSocket(): void {
        this.socket = net.connect(this.socketPath);
        this.socket.setEncoding('utf8');
        this.socket.on('data', (chunk: string) => {
            this.buffer += chunk;
            let newlineIndex = this.buffer.indexOf('\n');
            while (newlineIndex >= 0) {
                const line = this.buffer.slice(0, newlineIndex);
                this.buffer = this.buffer.slice(newlineIndex + 1);
                this.handleMessage(line);
                newlineIndex = this.buffer.indexOf('\n');
            }
        });
    }

    private createSocketPath(): string {
        if (process.platform === 'win32') {
            return `\\\\.\\pipe\\feishin-test-${process.pid}-${Math.floor(Math.random() * 100000)}`;
        }
        return path.join(
            os.tmpdir(),
            `feishin-test-mpv-${process.pid}-${Math.floor(Math.random() * 100000)}.sock`,
        );
    }

    private handleEvent(payload: Record<string, unknown>): void {
        this.eventHistory.push(payload);
        const ready = this.eventWaiters.filter((waiter) => matches(payload, waiter.options));
        for (const waiter of ready) {
            clearTimeout(waiter.timer);
            waiter.resolve(payload);
            this.eventWaiters = this.eventWaiters.filter((entry) => entry !== waiter);
        }
    }

    private handleMessage(line: string): void {
        let message: (MpvEvent & { request_id?: number }) | null = null;
        try {
            message = JSON.parse(line);
        } catch {
            return;
        }
        if (!message) {
            return;
        }
        if (typeof message.request_id === 'number' && ('error' in message || 'data' in message)) {
            const pending = this.pending.get(message.request_id);
            if (pending) {
                this.pending.delete(message.request_id);
                clearTimeout(pending.timer);
                pending.resolve({
                    data: message.data,
                    error: String(message.error),
                    request_id: message.request_id,
                });
            }
            return;
        }
        if (message.event) {
            this.handleEvent(message as Record<string, unknown>);
        }
    }

    private hasExited(): boolean {
        return this.processRef?.exitCode !== null && this.processRef?.exitCode !== undefined;
    }

    private async waitForSocket(timeoutMs: number): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (this.hasExited()) {
                throw new Error(`mpv failed to start. stderr:\n${this.stderrOutput}`);
            }
            if (process.platform === 'win32' || existsSync(this.socketPath)) {
                return;
            }
            await sleep(50);
        }
        throw new Error(
            `IPC socket never appeared at ${this.socketPath}. stderr:\n${this.stderrOutput}`,
        );
    }
}

export async function connectExtraClient(socketPath: string): Promise<{
    dispose(): void;
    request(command: unknown[], timeoutMs?: number): Promise<MpvResponse>;
    waitFor(options: WaitForOptions): Promise<Record<string, unknown>>;
}> {
    const requests = new Map<number, PendingRequest>();
    let nextId = 9000;
    const waiters: Array<{
        options: WaitForOptions;
        resolve: (payload: Record<string, unknown>) => void;
        timer: NodeJS.Timeout;
    }> = [];
    const history: Record<string, unknown>[] = [];
    const socket = net.connect(socketPath);
    socket.setEncoding('utf8');
    let buffer = '';

    socket.on('data', (chunk: string) => {
        buffer += chunk;
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex >= 0) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            try {
                const message = JSON.parse(line);
                if (
                    typeof message.request_id === 'number' &&
                    ('error' in message || 'data' in message)
                ) {
                    const pending = requests.get(message.request_id);
                    if (pending) {
                        requests.delete(message.request_id);
                        clearTimeout(pending.timer);
                        pending.resolve({ data: message.data, error: String(message.error) });
                    }
                } else if (message.event) {
                    history.push(message);
                    const ready = waiters.filter((waiter) => matches(message, waiter.options));
                    for (const waiter of ready) {
                        clearTimeout(waiter.timer);
                        waiter.resolve(message);
                        waiters.splice(waiters.indexOf(waiter), 1);
                    }
                }
            } catch {
                socket.destroy();
            }
            newlineIndex = buffer.indexOf('\n');
        }
    });

    return {
        dispose() {
            socket.destroy();
        },
        request(command: unknown[], timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
            if (!socket.writable) {
                return Promise.reject(new Error('extra client socket is not connected'));
            }
            const requestId = nextId++;
            return new Promise<MpvResponse>((resolve, reject) => {
                const timer = setTimeout(() => {
                    requests.delete(requestId);
                    reject(new Error(`extra client request timed out: ${JSON.stringify(command)}`));
                }, timeoutMs);
                requests.set(requestId, { reject, resolve, timer });
                socket.write(`${JSON.stringify({ command, request_id: requestId })}\n`);
            });
        },
        waitFor(options: WaitForOptions) {
            const existing = history.find((event) => matches(event, options));
            if (existing) {
                return Promise.resolve(existing);
            }
            return new Promise((resolve, reject) => {
                const timer = setTimeout(
                    () => reject(new Error(`extra client timed out waiting for ${options.name}`)),
                    options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
                );
                waiters.push({ options, resolve, timer });
            });
        },
    };
}

function matches(payload: Record<string, unknown>, options: WaitForOptions): boolean {
    if (options.name === 'property-change') {
        if (payload['event'] !== 'property-change') {
            return false;
        }
        return options.where ? options.where(payload) : true;
    }
    if (payload['event'] !== options.name) {
        return false;
    }
    return options.where ? options.where(payload) : true;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
