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
        // One analysis at a time: the panel runs a queue and cancels explicitly.
        if (activeRun) {
            return { status: 'busy' };
        }

        const availability = await resolveFfmpegBinaries();
        if (!availability.available) {
            return { reason: availability.reason, status: 'unavailable' };
        }

        const controller = new AbortController();
        activeRun = controller;
        try {
            return await runTrackAnalysis(request, availability, controller.signal);
        } finally {
            activeRun = null;
        }
    },
);
