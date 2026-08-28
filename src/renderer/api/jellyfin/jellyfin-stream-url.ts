type JellyfinStreamMode =
    | { bitrate?: number; format?: string; mode: 'transcode' }
    | { mode: 'direct' | 'original' };

type JellyfinStreamUrlOptions = JellyfinStreamMode & {
    credential?: string;
    id: string;
    serverUrl?: string;
    userId?: null | string;
};

export function buildJellyfinStreamUrl(options: JellyfinStreamUrlOptions): string {
    const deviceId = '';

    if (options.mode === 'transcode') {
        const format = options.format || 'mp3';
        let url =
            `${options.serverUrl}/audio/${options.id}/universal` +
            `?userId=${options.userId}` +
            `&deviceId=${deviceId}` +
            `&audioCodec=${format}` +
            `&apiKey=${options.credential}` +
            `&playSessionId=${deviceId}` +
            `&container=${format}` +
            `&transcodingProtocol=http&transcodingContainer=${format}`;

        if (options.bitrate !== undefined) {
            url += `&maxStreamingBitrate=${options.bitrate * 1000}`;
        }

        return url;
    }

    if (options.mode === 'direct') {
        return `${options.serverUrl}/Audio/${options.id}/stream?static=true&apiKey=${options.credential}`;
    }

    return `${options.serverUrl}/Items/${options.id}/Download?apiKey=${options.credential}&playSessionId=${deviceId}`;
}
