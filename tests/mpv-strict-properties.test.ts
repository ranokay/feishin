import type MpvAPIType from 'node-mpv';

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AudioSnapshot } from '../src/shared/signalpath';

import { AudioStateService } from '../src/main/features/core/player/mpv/audio-state';
import { MpvIpcConnection } from '../src/main/features/core/player/mpv/ipc-client';
import {
    BIT_PERFECT_PROPERTY_PINS,
    findStrictPropertyViolation,
    policyStartupConfig,
} from '../src/shared/signalpath';
import { connectExtraClient } from './harness/mpv-test-process';

const mpvBinaryPath =
    process.env.FEISHIN_TEST_MPV_BINARY ??
    ['/opt/homebrew/bin/mpv', '/usr/local/bin/mpv', '/usr/bin/mpv'].find((candidate) =>
        existsSync(candidate),
    );
const mpvAvailable = mpvBinaryPath !== undefined;
const socketPath = path.join(os.tmpdir(), `feishin-strict-node-mpv-${process.pid}.sock`);

let commandMpv: MpvAPIType;
let connection: MpvIpcConnection;
let externalClient: Awaited<ReturnType<typeof connectExtraClient>>;
let service: AudioStateService;
let snapshots: AudioSnapshot[] = [];

const waitFor = async (predicate: () => boolean, timeoutMs = 8000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error('timed out waiting for strict property state');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};

beforeAll(async () => {
    if (!mpvAvailable) {
        return;
    }
    const { default: MpvAPI } = await import('node-mpv');
    commandMpv = new MpvAPI(
        {
            audio_only: true,
            auto_restart: false,
            binary: mpvBinaryPath,
            socket: socketPath,
            time_update: 1,
        },
        ['--idle=yes', '--no-config', '--load-scripts=no', '--ao=null'],
    );
    await commandMpv.start();
    const { runtimeProperties } = policyStartupConfig('bit-perfect', 'linux');
    await commandMpv.setMultipleProperties(runtimeProperties);
    connection = await MpvIpcConnection.connect(socketPath);
    externalClient = await connectExtraClient(socketPath);
    service = new AudioStateService(connection, {
        broadcast: (snapshot) => snapshots.push(snapshot),
        intervalMs: 20,
        repairStrictProperty: async (pin) => {
            await commandMpv.setProperty(pin.name, pin.value);
        },
        strictPropertyPins: BIT_PERFECT_PROPERTY_PINS,
    });
    await service.start();
});

afterAll(async () => {
    service?.dispose();
    connection?.dispose();
    externalClient?.dispose();
    if (mpvAvailable) {
        await commandMpv.quit();
    }
});

describe.skipIf(!mpvAvailable)('strict property enforcement over real mpv IPC', () => {
    it('starts with exactly the pinned runtime property values', async () => {
        for (const pin of BIT_PERFECT_PROPERTY_PINS) {
            expect(
                findStrictPropertyViolation(pin, await commandMpv.getProperty(pin.name)),
            ).toBeNull();
        }
    });

    it('observes an external mutation and repairs it through the command client', async () => {
        snapshots = [];
        const response = await externalClient.request(['set_property', 'speed', 1.25]);
        expect(response.error).toBe('success');

        await waitFor(() =>
            snapshots.some((snapshot) =>
                snapshot.strictPropertyViolations.some(
                    (violation) => violation.property === 'speed',
                ),
            ),
        );
        await waitFor(() => snapshots.at(-1)?.strictPropertyViolations.length === 0);

        expect(await commandMpv.getProperty('speed')).toBe(1);
    });
});
