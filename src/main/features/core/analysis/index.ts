import type { AnalysisAvailability, AnalysisRequest, AnalysisResponse } from '/@/shared/analysis';

import { ipcMain } from 'electron';

import { resolveFfmpegBinaries } from './binaries';
import { runTrackAnalysis } from './runner';

let activeRun: AbortController | null = null;

const isHttpUrl = (value: unknown): value is string =>
    typeof value === 'string' && /^https?:\/\//i.test(value);

ipcMain.handle('analysis-check', async (): Promise<AnalysisAvailability> => {
    return resolveFfmpegBinaries();
});

ipcMain.handle('analysis-cancel', () => {
    activeRun?.abort();
});

ipcMain.handle(
    'analysis-run',
    async (_event, request: AnalysisRequest): Promise<AnalysisResponse> => {
        if (!request || !isHttpUrl(request.url)) {
            return { message: 'invalid analysis request', status: 'error' };
        }
        // One analysis at a time: claim the run before awaiting anything so
        // two concurrent invokes cannot both pass this check.
        if (activeRun) {
            return { status: 'busy' };
        }
        const controller = new AbortController();
        activeRun = controller;
        const label = typeof request.label === 'string' ? request.label.slice(0, 200) : undefined;

        try {
            const availability = await resolveFfmpegBinaries();
            if (!availability.available) {
                return { reason: availability.reason, status: 'unavailable' };
            }

            return await runTrackAnalysis(
                { label, url: request.url },
                availability,
                controller.signal,
            );
        } finally {
            activeRun = null;
        }
    },
);
