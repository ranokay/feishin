import type { AnalysisResult } from '/@/shared/analysis';

import { createStore, get, set } from 'idb-keyval';

import { logger } from '/@/renderer/utils/logger';
import { ANALYSIS_SCHEMA_VERSION } from '/@/shared/analysis';

const analysisStore = createStore('feishin-analysis', 'results');

export async function getCachedAnalysis(cacheKey: string): Promise<AnalysisResult | null> {
    try {
        const result = await get<AnalysisResult>(cacheKey, analysisStore);
        if (!result || result.schemaVersion !== ANALYSIS_SCHEMA_VERSION) {
            return null;
        }
        return result;
    } catch (error) {
        logger.warn('Failed to read analysis cache', { error: String(error) });
        return null;
    }
}

export async function setCachedAnalysis(cacheKey: string, result: AnalysisResult): Promise<void> {
    try {
        await set(cacheKey, result, analysisStore);
    } catch (error) {
        logger.warn('Failed to write analysis cache', { error: String(error) });
    }
}
