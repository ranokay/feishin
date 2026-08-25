import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
    createStandardFixtures,
    fixtureFileName,
    type FixtureSpec,
    resolveFfmpegBinary,
    STANDARD_FLAC_MATRIX,
    writeFlacFixture,
    writeWavFixture,
} from './fixtures/audio-fixtures';
import { connectExtraClient, MpvTestProcess } from './harness/mpv-test-process';

let ffmpegBinary: null | string = null;

const mpvAvailable = await MpvTestProcess.isAvailable();
ffmpegBinary = await resolveFfmpegBinary();

const mpv = new MpvTestProcess({ args: ['--ao=null', '--ao-null-untimed=yes'] });

beforeAll(async () => {
    if (!mpvAvailable) {
        return;
    }
    await mpv.start();
});

afterAll(async () => {
    if (mpvAvailable) {
        await mpv.dispose();
    }
});

describe.skipIf(!mpvAvailable)('mpv harness: process + IPC basics', () => {
    it('reports an mpv version over get_property', async () => {
        const version = await mpv.getProperty('mpv-version');
        expect(String(version)).toMatch(/^mpv/);
    });

    it('round-trips a property write and delivers observed property-change events', async () => {
        await mpv.observe(1, 'volume');
        await mpv.setProperty('volume', 77);

        const change = await mpv.waitFor({
            name: 'property-change',
            timeoutMs: 5000,
            where: (payload) => payload['id'] === 1 && payload['data'] === 77,
        });
        expect(change['name']).toBe('volume');
        expect(await mpv.getProperty('volume')).toBe(77);
    });

    it('plays a generated wav fixture to completion with end-file reason eof', async () => {
        const { dir } = await createStandardFixtures();
        const spec: FixtureSpec = {
            bitDepth: 16,
            channels: 2,
            durationSec: 1,
            frequencyHz: 1000,
            kind: 'sine',
            sampleRate: 44100,
        };
        const filePath = await writeWavFixture(dir, spec);

        await mpv.request(['loadfile', filePath]);
        const endFile = await mpv.waitFor({ name: 'end-file', timeoutMs: 15000 });
        expect(endFile['reason']).toBe('eof');
    });

    it('exposes decoder audio-params matching the fixture during playback', async () => {
        const { wavByFileName } = await createStandardFixtures();
        const key = fixtureFileName(
            {
                bitDepth: 24,
                channels: 2,
                durationSec: 1,
                frequencyHz: 1000,
                kind: 'sine',
                sampleRate: 96000,
            },
            'wav',
        );
        await mpv.observe(2, 'audio-params');
        await mpv.request(['loadfile', wavByFileName[key]]);

        const change = await mpv.waitFor({
            name: 'property-change',
            timeoutMs: 10000,
            where: (payload) =>
                payload['id'] === 2 &&
                typeof payload['data'] === 'object' &&
                payload['data'] !== null &&
                (payload['data'] as Record<string, unknown>)['samplerate'] === 96000,
        });
        expect((change['data'] as Record<string, unknown>)['samplerate']).toBe(96000);
    });

    it('advances through an appended playlist entry with prefetch enabled', async () => {
        const prefetchPlayer = new MpvTestProcess({
            args: ['--ao=null', '--ao-null-untimed=yes', '--prefetch-playlist=yes'],
        });
        try {
            await prefetchPlayer.start();
            const { wavByFileName } = await createStandardFixtures();
            const first = fixtureFileName(
                {
                    bitDepth: 16,
                    channels: 2,
                    durationSec: 1,
                    frequencyHz: 1000,
                    kind: 'sine',
                    sampleRate: 44100,
                },
                'wav',
            );
            const second = fixtureFileName(
                {
                    bitDepth: 16,
                    channels: 2,
                    durationSec: 1,
                    frequencyHz: 1000,
                    kind: 'sine',
                    sampleRate: 48000,
                },
                'wav',
            );

            await prefetchPlayer.observe(1, 'playlist-pos');
            await prefetchPlayer.request(['loadfile', wavByFileName[first]]);
            await prefetchPlayer.request(['loadfile', wavByFileName[second], 'append']);

            const advanced = await prefetchPlayer.waitFor({
                name: 'property-change',
                timeoutMs: 20000,
                where: (payload) => payload['id'] === 1 && payload['data'] === 1,
            });
            expect(advanced['name']).toBe('playlist-pos');
        } finally {
            await prefetchPlayer.dispose();
        }
    });

    it('supports a second IPC client observing the same mpv instance', async () => {
        const extra = await connectExtraClient(mpv.socketPath);
        try {
            await extra.request(['observe_property', 1, 'volume']);
            await mpv.setProperty('volume', 42);

            const seenByExtra = await extra.waitFor({
                name: 'property-change',
                timeoutMs: 5000,
                where: (payload) => payload['name'] === 'volume' && payload['data'] === 42,
            });
            expect(seenByExtra['event']).toBe('property-change');
        } finally {
            extra.dispose();
        }
    });
});

describe.skipIf(!mpvAvailable || !ffmpegBinary)(
    'mpv harness: flac fixtures via system ffmpeg',
    () => {
        it('decodes a generated flac fixture to completion', async () => {
            const { dir } = await createStandardFixtures();
            const filePath = await writeFlacFixture(dir, STANDARD_FLAC_MATRIX[0]);

            await mpv.request(['loadfile', filePath, 'replace']);
            const endFile = await mpv.waitFor({ name: 'end-file', timeoutMs: 15000 });
            expect(endFile['reason']).toBe('eof');
        });
    },
);
