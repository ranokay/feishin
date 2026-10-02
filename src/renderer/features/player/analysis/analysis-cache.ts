import type { AnalysisResult } from '/@/shared/analysis';

import { createStore, get, set } from 'idb-keyval';

import { logger } from '/@/renderer/utils/logger';

const analysisStore = createStore('feishin-analysis', 'results');

export async function getCachedAnalysis(cacheKey: string): Promise<AnalysisResult | null> {
    try {
        return (await get<AnalysisResult>(cacheKey, analysisStore)) ?? null;
    } catch (error) {
        logger.warn('Failed to read analysis cache', { error });
        return null;
    }
}

export async function setCachedAnalysis(cacheKey: string, result: AnalysisResult): Promise<void> {
    try {
        await set(cacheKey, result, analysisStore);
    } catch (error) {
        logger.warn('Failed to write analysis cache', { error });
    }
}
