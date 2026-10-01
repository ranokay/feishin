type JellyfinStreamMode =
    | {
          bitrate?: number;
          container?: null | string;
          format?: string;
          forRenderer?: boolean;
          maxSampleRate?: number;
          mode: 'transcode';
          sampleRate?: null | number;
          startTime?: number;
      }
    | { mode: 'direct' | 'original' };

type JellyfinStreamUrlOptions = JellyfinStreamMode & {
    credential?: string;
    id: string;
    serverUrl?: string;
    userId?: null | string;
};

// Lossy encoders top out at 48 kHz (libmp3lame, libopus, aac); asking Jellyfin
// for more makes ffmpeg fail and the stream never starts.
const clampSampleRate = (rate: number | undefined, codec: string) =>
    rate && ['aac', 'mp3', 'ogg', 'opus', 'vorbis'].includes(codec) ? Math.min(rate, 48000) : rate;

export function buildJellyfinStreamUrl(options: JellyfinStreamUrlOptions): string {
    const deviceId = '';

    if (options.mode === 'direct') {
        return `${options.serverUrl}/Audio/${options.id}/stream?static=true&apiKey=${options.credential}`;
    }

    if (options.mode === 'transcode') {
        // A transcoded stream is chunked and cannot be ranged into, so a seek is expressed
        // as a new stream that starts at the requested offset.
        const startTimeTicks =
            options.startTime && options.startTime > 0
                ? Math.round(options.startTime * 10_000_000)
                : 0;
        // Jellyfin keys a running transcode on media path, user agent, device id and play
        // session id only. With an empty session id a request for the same file with new
        // parameters (another offset, a changed cap) is served from the job already running,
        // and a running job is also found by session id alone, so the id carries the item and
        // every parameter that must yield a different stream.
        const transcodeSession = (codec: string, rate: number | undefined) =>
            `feishin-${options.id}-${codec}-${rate ?? 0}-${startTimeTicks}`;

        if (options.forRenderer) {
            // UPnP/DLNA renderers commonly pick a decoder from the URL's file extension and
            // refuse the extension-less universal route, so build a stream.{format} URL for
            // them. That route takes an exact sample rate, so only cap when the source is
            // above the configured maximum, and send the file untouched when it already
            // matches the requested format.
            const realFormat = (options.format || 'mp3').toLowerCase();
            if (options.container?.toLowerCase() === realFormat) {
                return `${options.serverUrl}/Items/${options.id}/Download?apiKey=${options.credential}&playSessionId=${deviceId}`;
            }

            const cappedRate = clampSampleRate(options.maxSampleRate, realFormat);
            let url =
                `${options.serverUrl}/Audio/${options.id}/stream.${realFormat}` +
                `?audioCodec=${realFormat}` +
                `&static=false` +
                `&apiKey=${options.credential}` +
                `&playSessionId=${transcodeSession(realFormat, cappedRate)}`;

            if (options.bitrate !== undefined) {
                url += `&audioBitRate=${options.bitrate * 1000}`;
            }
            if (cappedRate && options.sampleRate && options.sampleRate > cappedRate) {
                url += `&audioSampleRate=${cappedRate}`;
            }
            if (startTimeTicks > 0) {
                url += `&startTimeTicks=${startTimeTicks}`;
            }

            return url;
        }

        // Some format appears to be required. Fall back to trusty MP3 if not specified
        // Otherwise, ffmpeg appears to crash
        const realFormat = options.format || 'mp3';
        let url =
            `${options.serverUrl}/audio/${options.id}/universal` +
            `?userId=${options.userId}` +
            `&deviceId=${deviceId}` +
            `&audioCodec=${realFormat}` +
            `&apiKey=${options.credential}` +
            `&playSessionId=${deviceId}` +
            `&container=${realFormat}` +
            `&transcodingProtocol=http&transcodingContainer=${realFormat}`;

        if (options.bitrate !== undefined) {
            url += `&maxStreamingBitrate=${options.bitrate * 1000}`;
        }
        const cappedRate = clampSampleRate(options.maxSampleRate, realFormat.toLowerCase());
        if (cappedRate) {
            url += `&maxAudioSampleRate=${cappedRate}`;
        }
        if (startTimeTicks > 0) {
            url += `&startTimeTicks=${startTimeTicks}`;
        }

        return url.replace(
            `&playSessionId=${deviceId}`,
            `&playSessionId=${transcodeSession(realFormat.toLowerCase(), cappedRate)}`,
        );
    }

    return `${options.serverUrl}/Items/${options.id}/Download?apiKey=${options.credential}&playSessionId=${deviceId}`;
}
