import type {
    AnalysisEntry,
    AnalysisEntryStatus,
} from '/@/renderer/features/player/analysis/use-analysis-job';
import type { AnalysisFinding, AnalysisResult } from '/@/shared/analysis';
import type { Song } from '/@/shared/types/domain-types';

import { openModal } from '@mantine/modals';
import formatDuration from 'format-duration';
import { t } from 'i18next';
import { useTranslation } from 'react-i18next';

import { useAnalysisJob } from '/@/renderer/features/player/analysis/use-analysis-job';
import { Badge } from '/@/shared/components/badge/badge';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { Progress } from '/@/shared/components/progress/progress';
import { ScrollArea } from '/@/shared/components/scroll-area/scroll-area';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';

const STATUS_KEY: Record<AnalysisEntryStatus, string> = {
    cached: 'player.analysis_status_cached',
    cancelled: 'player.analysis_status_cancelled',
    done: 'player.analysis_status_done',
    error: 'player.analysis_status_error',
    pending: 'player.analysis_status_pending',
    running: 'player.analysis_status_running',
    unavailable: 'player.analysis_status_unavailable',
};

const STATUS_COLOR: Partial<Record<AnalysisEntryStatus, string>> = {
    cancelled: 'gray',
    error: 'red',
    running: 'blue',
};

const FINISHED_STATUSES: AnalysisEntryStatus[] = [
    'cached',
    'cancelled',
    'done',
    'error',
    'unavailable',
];

function AnalysisDetails({ result }: { result: AnalysisResult }) {
    const { t: translate } = useTranslation();
    const { measurements, source } = result;

    return (
        <Stack gap={2}>
            <DetailRow
                label={translate('player.analysis_label_format')}
                value={[source.codec, source.container].filter(Boolean).join(' / ') || null}
            />
            <DetailRow
                label={translate('player.analysis_label_sampleRate')}
                value={formatKhz(source.sampleRate)}
            />
            <DetailRow
                label={translate('player.analysis_label_bitDepth')}
                value={source.bitDepth === null ? null : `${source.bitDepth}-bit`}
            />
            <DetailRow
                label={translate('player.analysis_label_channels')}
                value={source.channels === null ? null : String(source.channels)}
            />
            <DetailRow
                label={translate('player.analysis_label_duration')}
                value={
                    source.durationSec === null
                        ? null
                        : formatDuration(Math.round(source.durationSec * 1000))
                }
            />
            <DetailRow
                label={translate('player.analysis_label_loudness')}
                value={
                    measurements.loudnessLufs === null ? null : `${measurements.loudnessLufs} LUFS`
                }
            />
            <DetailRow
                label={translate('player.analysis_label_loudnessRange')}
                value={
                    measurements.loudnessRangeLu === null
                        ? null
                        : `${measurements.loudnessRangeLu} LU`
                }
            />
            <DetailRow
                label={translate('player.analysis_label_samplePeak')}
                value={formatDbfs(measurements.samplePeakDbfs)}
            />
            <DetailRow
                label={translate('player.analysis_label_truePeak')}
                value={formatDbfs(measurements.truePeakDbfs)}
            />
            <DetailRow
                label={translate('player.analysis_label_rms')}
                value={formatDbfs(measurements.rmsDbfs)}
            />
            <DetailRow
                label={translate('player.analysis_label_crestFactor')}
                value={formatDb(measurements.crestFactorDb)}
            />
            <DetailRow
                label={translate('player.analysis_label_dcOffset')}
                value={measurements.dcOffset === null ? null : measurements.dcOffset.toFixed(4)}
            />
            <DetailRow
                label={translate('player.analysis_label_noiseFloor')}
                value={formatDbfs(measurements.noiseFloorDbfs)}
            />
            <DetailRow
                label={translate('player.analysis_label_effectiveBitDepth')}
                value={
                    measurements.effectiveBitDepth === null
                        ? null
                        : `~${measurements.effectiveBitDepth}-bit`
                }
            />
            <DetailRow
                label={translate('player.analysis_label_spectralRolloff')}
                value={formatKhz(measurements.spectralRolloffHz)}
            />
            {result.findings.map((finding) => (
                <FindingText finding={finding} key={finding.kind} />
            ))}
        </Stack>
    );
}

function AnalysisRow({ entry }: { entry: AnalysisEntry }) {
    const { t: translate } = useTranslation();

    return (
        <Stack gap={4}>
            <Group gap="xs" justify="space-between" wrap="nowrap">
                <Text size="sm" truncate>
                    {entry.song.name}
                </Text>
                <Badge color={STATUS_COLOR[entry.status]} size="xs">
                    {translate(STATUS_KEY[entry.status])}
                </Badge>
            </Group>
            <Text c="dim" size="xs" truncate>
                {entry.song.artistName ?? ''}
            </Text>
            {entry.error && (
                <Text c="red" size="xs">
                    {entry.error.kind === 'busy'
                        ? translate('player.analysis_errorBusy')
                        : entry.error.message}
                </Text>
            )}
            {entry.result && <AnalysisDetails result={entry.result} />}
        </Stack>
    );
}

function DetailRow({ label, value }: { label: string; value: null | string }) {
    return (
        <Group gap="xs" justify="space-between" wrap="nowrap">
            <Text c="dim" size="xs">
                {label}
            </Text>
            <Text size="xs">{value ?? t('player.analysis_unknown')}</Text>
        </Group>
    );
}

function FindingText({ finding }: { finding: AnalysisFinding }) {
    const { t: translate } = useTranslation();

    return (
        <Text c="dim" size="xs">
            {translate('player.analysis_finding_effectiveResolution', {
                effective: finding.effectiveBitDepth,
                noiseFloor: finding.noiseFloorDbfs.toFixed(1),
                nominal: finding.nominalBitDepth,
            })}
        </Text>
    );
}

function formatDb(value: null | number): null | string {
    return value === null ? null : `${value.toFixed(1)} dB`;
}

function formatDbfs(value: null | number): null | string {
    return value === null ? null : `${value.toFixed(1)} dBFS`;
}

function formatKhz(value: null | number): null | string {
    return value === null ? null : `${(value / 1000).toFixed(1)} kHz`;
}

const TrackAnalysisPanel = ({ songs }: { songs: Song[] }) => {
    const { t: translate } = useTranslation();
    const { availability, cancel, entries, finished } = useAnalysisJob(songs);
    const completed = entries.filter((entry) => FINISHED_STATUSES.includes(entry.status)).length;

    return (
        <Stack gap="sm">
            {availability && !availability.available && (
                <Stack gap={2}>
                    <Text fw={600} size="sm">
                        {translate('player.analysis_unavailable')}
                    </Text>
                    <Text c="dim" size="xs">
                        {translate(
                            availability.reason === 'missing-ffprobe'
                                ? 'player.analysis_unavailableFfprobe'
                                : 'player.analysis_unavailableFfmpeg',
                        )}
                    </Text>
                </Stack>
            )}
            <Group justify="space-between">
                <Text c="dim" size="xs">
                    {translate('player.analysis_progress', {
                        completed,
                        total: entries.length,
                    })}
                </Text>
                {!finished && (
                    <Button onClick={cancel} size="xs" variant="subtle">
                        {translate('player.analysis_cancel')}
                    </Button>
                )}
            </Group>
            {!finished && (
                <Progress value={entries.length === 0 ? 0 : (completed / entries.length) * 100} />
            )}
            <ScrollArea style={{ maxHeight: 480 }}>
                <Stack gap="md">
                    {entries.map((entry) => (
                        <AnalysisRow entry={entry} key={entry.cacheKey} />
                    ))}
                </Stack>
            </ScrollArea>
        </Stack>
    );
};

/**
 * Remounts the panel when the analyzed set changes, so reopening with another
 * track/album (same modal id) cancels the previous queue instead of stacking a
 * second one the main process would reject as busy.
 */
export const TrackAnalysisModal = ({ songs }: { songs: Song[] }) => {
    const signature = songs
        .map(
            (song) =>
                `${song._serverId}:${song.id}:${song.size}:${song.updatedAt}:${song.createdAt}`,
        )
        .join('|');

    return <TrackAnalysisPanel key={signature} songs={songs} />;
};

export const openTrackAnalysis = (songs: Song[]) => {
    openModal({
        children: <TrackAnalysisModal songs={songs} />,
        modalId: 'track-analysis',
        size: 'lg',
        title: t('player.analysis_title'),
    });
};
