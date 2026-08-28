import { describe, expect, it } from 'vitest';

import { buildJellyfinStreamUrl } from '../src/renderer/api/jellyfin/jellyfin-stream-url';
import { buildSubsonicStreamUrl } from '../src/renderer/api/subsonic/subsonic-stream-url';

describe('direct stream URL builders', () => {
    it('forces raw Subsonic bytes for LOCAL playback without a bitrate cap', () => {
        const baseUrl =
            'https://music.example/rest/stream.view?id=42&v=1.13.0&c=Feishin&u=test&t=token&s=salt';

        expect(
            buildSubsonicStreamUrl(baseUrl, {
                mode: 'direct',
            }),
        ).toBe(`${baseUrl}&format=raw`);
    });

    it('keeps explicit Subsonic transcoding unchanged for WEB playback', () => {
        const baseUrl =
            'https://music.example/rest/stream.view?id=42&v=1.13.0&c=Feishin&u=test&t=token&s=salt';

        expect(
            buildSubsonicStreamUrl(baseUrl, {
                bitrate: 192,
                format: 'opus',
                mode: 'transcode',
            }),
        ).toBe(`${baseUrl}&format=opus&maxBitRate=192`);
    });

    it('uses Jellyfin static streaming for LOCAL playback', () => {
        expect(
            buildJellyfinStreamUrl({
                credential: 'secret',
                id: '42',
                mode: 'direct',
                serverUrl: 'https://jellyfin.example',
                userId: 'user',
            }),
        ).toBe('https://jellyfin.example/Audio/42/stream?static=true&apiKey=secret');
    });

    it('keeps Jellyfin WEB transcoding unchanged', () => {
        expect(
            buildJellyfinStreamUrl({
                bitrate: 192,
                credential: 'secret',
                format: 'opus',
                id: '42',
                mode: 'transcode',
                serverUrl: 'https://jellyfin.example',
                userId: 'user',
            }),
        ).toBe(
            'https://jellyfin.example/audio/42/universal?userId=user&deviceId=&audioCodec=opus&apiKey=secret&playSessionId=&container=opus&transcodingProtocol=http&transcodingContainer=opus&maxStreamingBitrate=192000',
        );
    });
});
