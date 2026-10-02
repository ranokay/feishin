import type { AnalysisAvailability, AnalysisRequest, AnalysisResponse } from '/@/shared/analysis';

import { ipcRenderer } from 'electron';

const cancel = (): Promise<void> => {
    return ipcRenderer.invoke('analysis-cancel');
};

const check = (): Promise<AnalysisAvailability> => {
    return ipcRenderer.invoke('analysis-check');
};

const run = (request: AnalysisRequest): Promise<AnalysisResponse> => {
    return ipcRenderer.invoke('analysis-run', request);
};

export const analysis = {
    cancel,
    check,
    run,
};

export type AnalysisApi = typeof analysis;
