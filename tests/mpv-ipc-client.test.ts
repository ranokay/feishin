import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MpvCommandError, MpvIpcConnection } from '../src/main/features/core/player/mpv/ipc-client';
import { createStandardFixtures, writeWavFixture } from './fixtures/audio-fixtures';
import { MpvTestProcess } from './harness/mpv-test-process';

const mpvAvailable = await MpvTestProcess.isAvailable();

const mpv = new MpvTestProcess({
    args: ['--ao=null', '--ao-null-untimed=yes', '--msg-level=all=info'],
});
let connection: MpvIpcConnection;

beforeAll(async () => {
    if (!mpvAvailable) {
        return;
    }
    await mpv.start();
    connection = await MpvIpcConnection.connect(mpv.socketPath);
});

afterAll(async () => {
    if (connection) {
        connection.dispose();
    }
    if (mpvAvailable) {
        await mpv.dispose();
    }
});

describe.skipIf(!mpvAvailable)('MpvIpcConnection', () => {
    it('executes commands and returns typed data', async () => {
        const version = await connection.request<string>(['get_property', 'mpv-version']);
        expect(version).toMatch(/^mpv/);
    });

    it('surfaces mpv error replies as MpvCommandError with the mpv error string', async () => {
        await expect(
            connection.request(['get_property', 'definitely-not-a-property']),
        ).rejects.toThrow(MpvCommandError);
        await expect(
            connection.request(['get_property', 'definitely-not-a-property']),
        ).rejects.toMatchObject({
            mpvError: 'property not found',
        });
    });

    it('delivers observed property-change events to subscribed handlers', async () => {
        await connection.observe(501, 'volume');
        const received = await new Promise<Record<string, unknown>>((resolve) => {
            const unsubscribe = connection.onEvent('property-change', (payload) => {
                if (payload['name'] === 'volume' && payload['data'] === 66) {
                    unsubscribe();
                    resolve(payload);
                }
            });
            setTimeout(() => resolve({}), 8000);
            void mpv.setProperty('volume', 66);
        });
        expect(received['id']).toBe(501);
    });

    it('captures end-file reasons during real playback', async () => {
        const { dir } = await createStandardFixtures();
        const filePath = await writeWavFixture(dir, {
            bitDepth: 16,
            channels: 2,
            durationSec: 1,
            frequencyHz: 1000,
            kind: 'sine',
            sampleRate: 44100,
        });

        const endFile = await new Promise<Record<string, unknown>>((resolve) => {
            const unsubscribe = connection.onEvent('end-file', (payload) => {
                unsubscribe();
                resolve(payload);
            });
            void mpv.request(['loadfile', filePath]);
        });
        expect(endFile['reason']).toBe('eof');
    });

    it('receives log-message events after enabling a level', async () => {
        await connection.enableLogMessages('info');
        const sawLogMessage = await new Promise<boolean>((resolve) => {
            let seen = false;
            const unsubscribe = connection.onEvent('log-message', () => {
                if (!seen) {
                    seen = true;
                    unsubscribe();
                    resolve(true);
                }
            });
            void (async () => {
                const { dir } = await createStandardFixtures();
                const filePath = await writeWavFixture(dir, {
                    bitDepth: 16,
                    channels: 2,
                    durationSec: 1,
                    frequencyHz: 440,
                    kind: 'sine',
                    sampleRate: 48000,
                });
                await mpv.request(['loadfile', filePath]);
            })();
            setTimeout(() => resolve(seen), 10000);
        });
        expect(sawLogMessage).toBe(true);
    });

    it('coexists with an independent client issuing commands on the same instance', async () => {
        const viaConnection = connection.request<string>(['get_property', 'mpv-version']);
        const viaHarness = mpv.getProperty('mpv-version');
        const [a, b] = await Promise.all([viaConnection, viaHarness]);
        expect(a).toBe(b);
        expect(String(a)).toMatch(/^mpv/);
    });

    it('dispose only closes the connection and leaves mpv usable by other clients', async () => {
        connection.dispose();
        expect(connection.connected).toBe(false);

        const version = await mpv.getProperty('mpv-version');
        expect(String(version)).toMatch(/^mpv/);

        const reopened = await MpvIpcConnection.connect(mpv.socketPath);
        const versionAgain = await reopened.request<string>(['get_property', 'mpv-version']);
        expect(versionAgain).toMatch(/^mpv/);
        reopened.dispose();

        await mpv.setProperty('volume', 55);
    });
});
