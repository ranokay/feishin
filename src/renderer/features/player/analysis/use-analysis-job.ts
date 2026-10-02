import type { AnalysisAvailability, AnalysisResult } from '/@/shared/analysis';
import type { Song } from '/@/shared/types/domain-types';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getCachedAnalysis, setCachedAnalysis } from './analysis-cache';

import { getSongUrl } from '/@/renderer/features/player/audio-player/hooks/use-stream-url';
import { logger } from '/@/renderer/utils/logger';
import { analysisCacheKey } from '/@/shared/analysis';

export interface AnalysisEntry {
    cacheKey: string;
    error?: string;
    result?: AnalysisResult;
    song: Song;
    status: AnalysisEntryStatus;
}

export type AnalysisEntryStatus =
    | 'cached'
    | 'cancelled'
    | 'done'
    | 'error'
    | 'pending'
    | 'running'
    | 'unavailable';

export interface AnalysisJobResult {
    availability: AnalysisAvailability | null;
    cancel: () => void;
    entries: AnalysisEntry[];
    finished: boolean;
}

interface AnalysisTarget {
    cacheKey: string;
    song: Song;
}

/**
 * Runs the analysis queue for a fixed set of songs: cache hits resolve
 * immediately, the rest run one at a time through the main process. Cancel
 * stops the queue and aborts the in-flight download/ffmpeg; unmounting does
 * the same so no analysis outlives its panel.
 */
export function useAnalysisJob(songs: Song[]): AnalysisJobResult {
    const targets = useMemo<AnalysisTarget[]>(() => {
        const seen = new Set<string>();
        const list: AnalysisTarget[] = [];
        for (const song of songs) {
            const cacheKey = analysisCacheKey({
                serverId: song._serverId,
                size: song.size,
                songId: song.id,
                updatedAt: song.updatedAt,
            });
            if (seen.has(cacheKey)) {
                continue;
            }
            seen.add(cacheKey);
            list.push({ cacheKey, song });
        }
        return list;
    }, [songs]);

    const [entries, setEntries] = useState<AnalysisEntry[]>(() =>
        targets.map(({ cacheKey, song }) => ({ cacheKey, song, status: 'pending' as const })),
    );
    const [availability, setAvailability] = useState<AnalysisAvailability | null>(null);
    const [finished, setFinished] = useState(false);
    const stopRef = useRef(false);

    useEffect(() => {
        let disposed = false;
        stopRef.current = false;

        const patchEntry = (cacheKey: string, patch: Partial<AnalysisEntry>) => {
            setEntries((prev) =>
                prev.map((entry) => (entry.cacheKey === cacheKey ? { ...entry, ...patch } : entry)),
            );
        };
        const patchPending = (status: AnalysisEntryStatus) => {
            setEntries((prev) =>
                prev.map((entry) => (entry.status === 'pending' ? { ...entry, status } : entry)),
            );
        };

        const runQueue = async () => {
            const api = window.api?.analysis;
            if (!api) {
                patchPending('unavailable');
                setFinished(true);
                return;
            }

            const resolvedAvailability = await api.check();
            if (disposed) {
                return;
            }
            setAvailability(resolvedAvailability);

            const completed = new Set<string>();
            await Promise.all(
                targets.map(async ({ cacheKey }) => {
                    const cached = await getCachedAnalysis(cacheKey);
                    if (cached) {
                        completed.add(cacheKey);
                        patchEntry(cacheKey, { result: cached, status: 'cached' });
                    }
                }),
            );
            if (disposed) {
                return;
            }

            if (!resolvedAvailability.available) {
                patchPending('unavailable');
                setFinished(true);
                return;
            }

            for (const { cacheKey, song } of targets) {
                if (disposed || stopRef.current) {
                    break;
                }
                if (completed.has(cacheKey)) {
                    continue;
                }

                patchEntry(cacheKey, { status: 'running' });
                try {
                    const url = await getSongUrl(song, { enabled: false }, true);
                    if (disposed || stopRef.current) {
                        break;
                    }
                    const response = await api.run({ label: song.name, url });
                    if (disposed) {
                        return;
                    }

                    if (response.status === 'ok') {
                        await setCachedAnalysis(cacheKey, response.result);
                        patchEntry(cacheKey, { result: response.result, status: 'done' });
                    } else if (response.status === 'cancelled') {
                        patchEntry(cacheKey, { status: 'cancelled' });
                        break;
                    } else if (response.status === 'unavailable') {
                        setAvailability({ available: false, reason: response.reason });
                        patchEntry(cacheKey, { status: 'unavailable' });
                        patchPending('unavailable');
                        break;
                    } else if (response.status === 'busy') {
                        patchEntry(cacheKey, { error: 'busy', status: 'error' });
                    } else {
                        patchEntry(cacheKey, { error: response.message, status: 'error' });
                    }
                } catch (error) {
                    if (disposed) {
                        return;
                    }
                    logger.warn('Analysis run failed', { error: String(error) });
                    patchEntry(cacheKey, {
                        error: error instanceof Error ? error.message : 'analysis failed',
                        status: 'error',
                    });
                }
            }

            if (disposed) {
                return;
            }
            if (stopRef.current) {
                setEntries((prev) =>
                    prev.map((entry) => {
                        if (entry.status === 'pending' || entry.status === 'running') {
                            return { ...entry, status: 'cancelled' };
                        }
                        return entry;
                    }),
                );
            }
            setFinished(true);
        };

        void runQueue();

        return () => {
            disposed = true;
            stopRef.current = true;
            void window.api?.analysis?.cancel();
        };
    }, [targets]);

    const cancel = useCallback(() => {
        stopRef.current = true;
        void window.api?.analysis?.cancel();
    }, []);

    return { availability, cancel, entries, finished };
}
