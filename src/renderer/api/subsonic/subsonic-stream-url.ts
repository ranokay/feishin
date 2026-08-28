type SubsonicStreamUrlOptions =
    | { bitrate?: number; format?: string; mode: 'transcode' }
    | { mode: 'direct' };

export function buildSubsonicStreamUrl(url: string, options: SubsonicStreamUrlOptions): string {
    if (options.mode === 'transcode') {
        let streamUrl = url;

        if (options.format) {
            streamUrl += `&format=${options.format}`;
        }
        if (options.bitrate !== undefined) {
            streamUrl += `&maxBitRate=${options.bitrate}`;
        }

        return streamUrl;
    }

    // Older Subsonic-compatible servers may ignore format=raw. Runtime route
    // verification remains authoritative and reports any resulting transcode.
    return `${url}&format=raw`;
}
