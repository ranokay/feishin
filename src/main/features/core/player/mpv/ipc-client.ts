import { connect as netConnect, type Socket } from 'node:net';

export interface MpvCommandResponse<T = unknown> {
    data: T;
    error: string;
}

export type MpvEventHandler = (payload: MpvEventPayload) => void;

export interface MpvEventPayload {
    [event: string]: unknown;
    event: string;
}

interface PendingRequest {
    reject: (error: Error) => void;
    resolve: (response: MpvCommandResponse) => void;
    timer: NodeJS.Timeout;
}

export class MpvCommandError extends Error {
    constructor(
        public readonly command: unknown[],
        public readonly mpvError: string,
    ) {
        super(`mpv command failed (${mpvError}): ${JSON.stringify(command)}`);
        this.name = 'MpvCommandError';
    }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 8000;

export class MpvIpcConnection {
    get connected(): boolean {
        return this.socket !== null && !this.disposed && this.socket.writable;
    }
    private buffer = '';
    private closeHandlers = new Set<() => void>();
    private disposed = false;
    private eventHandlers = new Map<string, Set<MpvEventHandler>>();
    private nextRequestId = 1;
    private pending = new Map<number, PendingRequest>();

    private socket: null | Socket = null;

    constructor(readonly socketPath: string) {}

    static async connect(socketPath: string, connectTimeoutMs = 15000): Promise<MpvIpcConnection> {
        const connection = new MpvIpcConnection(socketPath);
        connection.socket = await openSocket(socketPath, connectTimeoutMs);
        connection.attach();
        return connection;
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        for (const [id, pending] of this.pending.entries()) {
            clearTimeout(pending.timer);
            pending.reject(new Error(`connection disposed while request ${id} was in flight`));
        }
        this.pending.clear();
        this.socket?.destroy();
        this.socket = null;
    }

    async enableLogMessages(level: string): Promise<void> {
        await this.request(['request_log_messages', level]);
    }

    async observe(id: number, propertyName: string): Promise<void> {
        await this.request(['observe_property', id, propertyName]);
    }

    onClose(handler: () => void): () => void {
        this.closeHandlers.add(handler);
        return () => {
            this.closeHandlers.delete(handler);
        };
    }

    onEvent(eventName: string, handler: MpvEventHandler): () => void {
        const handlers = this.eventHandlers.get(eventName) ?? new Set<MpvEventHandler>();
        handlers.add(handler);
        this.eventHandlers.set(eventName, handlers);
        return () => {
            handlers.delete(handler);
        };
    }

    async rawRequest(
        command: unknown[],
        timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    ): Promise<MpvCommandResponse> {
        const socket = this.requireSocket();
        const requestId = this.nextRequestId++;
        return new Promise<MpvCommandResponse>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(
                    new Error(
                        `mpv IPC request timed out after ${timeoutMs}ms: ${JSON.stringify(command)}`,
                    ),
                );
            }, timeoutMs);
            this.pending.set(requestId, { reject, resolve, timer });
            socket.write(`${JSON.stringify({ command, request_id: requestId })}\n`);
        });
    }

    async request<T = unknown>(
        command: unknown[],
        timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    ): Promise<T> {
        const response = await this.rawRequest(command, timeoutMs);
        if (response.error !== 'success') {
            throw new MpvCommandError(command, response.error);
        }
        return response.data as T;
    }

    async unobserve(id: number): Promise<void> {
        await this.request(['unobserve_property', id]);
    }

    private attach(): void {
        const socket = this.socket;
        if (!socket) {
            return;
        }
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => this.consumeChunk(chunk));
        socket.on('close', () => this.handleClose());
        socket.on('error', () => this.handleClose());
    }

    private consumeChunk(chunk: string): void {
        this.buffer += chunk;
        let newlineIndex = this.buffer.indexOf('\n');
        while (newlineIndex >= 0) {
            const line = this.buffer.slice(0, newlineIndex);
            this.buffer = this.buffer.slice(newlineIndex + 1);
            this.handleLine(line);
            newlineIndex = this.buffer.indexOf('\n');
        }
    }

    private dispatchEvent(eventName: string, payload: MpvEventPayload): void {
        const handlers = this.eventHandlers.get(eventName);
        if (!handlers) {
            return;
        }
        for (const handler of [...handlers]) {
            handler(payload);
        }
    }

    private handleClose(): void {
        for (const [, pending] of this.pending.entries()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('mpv IPC connection closed'));
        }
        this.pending.clear();
        for (const handler of [...this.closeHandlers]) {
            handler();
        }
    }

    private handleLine(line: string): void {
        let message: Record<string, unknown>;
        try {
            message = JSON.parse(line);
        } catch {
            return;
        }
        const requestId = message.request_id;
        if (typeof requestId === 'number') {
            const pending = this.pending.get(requestId);
            if (pending) {
                this.pending.delete(requestId);
                clearTimeout(pending.timer);
                pending.resolve({
                    data: message.data,
                    error: String(message.error ?? 'internal error'),
                });
            }
            return;
        }
        if (typeof message.event === 'string') {
            this.dispatchEvent(message.event, message as MpvEventPayload);
        }
    }

    private requireSocket(): Socket {
        if (!this.connected || !this.socket) {
            throw new Error('mpv IPC connection is not open');
        }
        return this.socket;
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openSocket(socketPath: string, timeoutMs: number): Promise<Socket> {
    const deadline = Date.now() + timeoutMs;
    let lastError: Error | null = null;
    while (Date.now() < deadline) {
        try {
            return await new Promise<Socket>((resolve, reject) => {
                const socket = netConnect(socketPath);
                socket.once('connect', () => resolve(socket));
                socket.once('error', (error) => {
                    socket.destroy();
                    reject(error);
                });
            });
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            await delay(100);
        }
    }
    throw new Error(
        `could not connect to mpv IPC at ${socketPath}: ${lastError?.message ?? 'timeout'}`,
    );
}
