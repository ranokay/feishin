import dayjs from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { EvidenceDot, formatServerStage, StageRow } from './signal-path-rows';
import styles from './stream-inspector-modal.module.css';

import { useAudioSnapshot } from '/@/renderer/store/audio-state.store';
import { usePlayerSong } from '/@/renderer/store/player.store';
import { useSettingsStore } from '/@/renderer/store/settings.store';
import { logger } from '/@/renderer/utils/logger';
import { Code } from '/@/shared/components/code/code';
import { CopyButton } from '/@/shared/components/copy-button/copy-button';
import { Group } from '/@/shared/components/group/group';
import { ScrollArea } from '/@/shared/components/scroll-area/scroll-area';
import { Select } from '/@/shared/components/select/select';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';
import {
    AUDIO_EVENT_CATEGORIES,
    AUDIO_EVENT_SEVERITIES,
    type AudioEngineEvent,
    type AudioEventCategory,
    type AudioEventSeverity,
    audioEventSeverity,
    buildDiagnosticsReport,
    buildSignalPathModel,
    declareSource,
    filterAudioEvents,
} from '/@/shared/signalpath';
import { PlayerType } from '/@/shared/types/types';

const CATEGORY_OPTIONS = ['all', ...AUDIO_EVENT_CATEGORIES] as const;

const SEVERITY_OPTIONS = ['all', ...AUDIO_EVENT_SEVERITIES] as const;

const SEVERITY_CLASS: Record<AudioEventSeverity, string> = {
    debug: styles.severityDebug,
    error: styles.severityError,
    info: styles.severityInfo,
    warning: styles.severityWarning,
};

const UNKNOWN = '-';

function bool(part: boolean | null): string {
    return part === null ? UNKNOWN : String(part);
}

const DetailRow = ({ label, value }: { label: string; value?: null | string }) => (
    <Group align="flex-start" gap="xs" justify="space-between" wrap="nowrap">
        <Text c="dim" size="xs" style={{ flexShrink: 0 }}>
            {label}
        </Text>
        <Text size="xs" truncate>
            {value ?? UNKNOWN}
        </Text>
    </Group>
);

function Section({
    actions,
    children,
    title,
}: {
    actions?: React.ReactNode;
    children: React.ReactNode;
    title: string;
}) {
    return (
        <Stack gap="xs">
            <Group justify="space-between" wrap="nowrap">
                <Text fw={600} size="sm">
                    {title}
                </Text>
                {actions}
            </Group>
            <Stack gap={6}>{children}</Stack>
        </Stack>
    );
}

export const StreamInspectorModal = () => {
    const { t } = useTranslation();
    const playbackType = useSettingsStore((state) => state.playback.type);
    const policy = useSettingsStore((state) => state.playback.playbackPolicy);
    const replayGainMode = useSettingsStore((state) => state.playback.mpvProperties.replayGainMode);
    const song = usePlayerSong();
    const snapshot = useAudioSnapshot();

    const [events, setEvents] = useState<AudioEngineEvent[]>([]);
    const [categoryFilter, setCategoryFilter] = useState<'all' | AudioEventCategory>('all');
    const [severityFilter, setSeverityFilter] = useState<'all' | AudioEventSeverity>('all');

    // The event log is query-only; refresh it whenever the engine broadcasts.
    useEffect(() => {
        if (!window.api?.audioState?.getEvents) {
            return;
        }
        window.api.audioState
            .getEvents()
            .then(setEvents)
            .catch((error) => logger.warn('Failed to load audio engine event log', { error }));
    }, [snapshot?.sequence]);

    const source = useMemo(
        () =>
            declareSource({
                bitDepth: song?.bitDepth ?? null,
                channels: song?.channels ?? null,
                container: song?.container ?? null,
                sampleRate: song?.sampleRate ?? null,
            }),
        [song?.bitDepth, song?.channels, song?.container, song?.sampleRate],
    );

    const model = useMemo(
        () => buildSignalPathModel({ policy, replayGainMode, snapshot, source }),
        [policy, replayGainMode, snapshot, source],
    );

    const report = useMemo(
        () => buildDiagnosticsReport({ events, policy, replayGainMode, snapshot, source }),
        [events, policy, replayGainMode, snapshot, source],
    );

    if (playbackType !== PlayerType.LOCAL) {
        return (
            <Text c="dim" size="sm">
                {t('player.signalPath_inspectorLocalOnly')}
            </Text>
        );
    }

    const filteredEvents = filterAudioEvents(events, {
        category: categoryFilter,
        severity: severityFilter,
    });

    return (
        <Stack gap="md" w="100%">
            <Section title={t('player.signalPath_inspectorSource')}>
                <StageRow item={model.source} label={t('player.signalPath_stageSource')} />
                <DetailRow
                    label={t('player.signalPath_inspectorUrl')}
                    value={snapshot?.streamUrl}
                />
                <StageRow
                    item={{
                        ...model.server,
                        detail: formatServerStage(snapshot?.serverRoute, t),
                    }}
                    label={t('player.signalPath_stageServer')}
                />
            </Section>

            <Section title={t('player.signalPath_inspectorMpv')}>
                <DetailRow
                    label="demuxer"
                    value={
                        snapshot?.demuxer
                            ? `${snapshot.demuxer.codec ?? '?'} @ ${snapshot.demuxer.samplerate ?? '?'} Hz ${snapshot.demuxer.channels ?? '?'}ch`
                            : undefined
                    }
                />
                <DetailRow
                    label="decoded"
                    value={
                        snapshot?.decodedParams
                            ? `${snapshot.decodedParams.format ?? '?'} / ${snapshot.decodedParams.samplerate ?? '?'} Hz / ${snapshot.decodedParams.channels ?? '?'}ch`
                            : undefined
                    }
                />
                <DetailRow
                    label="af"
                    value={
                        snapshot?.activeFilters === null || snapshot?.activeFilters === undefined
                            ? undefined
                            : snapshot.activeFilters.length > 0
                              ? snapshot.activeFilters.join(', ')
                              : t('player.signalPath_dspNone')
                    }
                />
                <StageRow item={model.output} label={t('player.signalPath_stageOutput')} />
                <DetailRow
                    label="out params"
                    value={
                        snapshot?.outputParams
                            ? `${snapshot.outputParams.format ?? '?'} / ${snapshot.outputParams.samplerate ?? '?'} Hz / ${snapshot.outputParams.channels ?? '?'}ch`
                            : undefined
                    }
                />
                <DetailRow
                    label="cache"
                    value={
                        snapshot
                            ? `eof-reaching: ${bool(snapshot.cacheEofReaching)} | idle: ${bool(snapshot.cacheIdle)} | underrun: ${bool(snapshot.cacheUnderrun)}`
                            : undefined
                    }
                />
                <DetailRow label="gapless" value={snapshot?.gaplessAudio ?? undefined} />
            </Section>

            <Section title={t('player.signalPath_inspectorDevice')}>
                <StageRow item={model.device} label={t('player.signalPath_stageDevice')} />
                {snapshot?.physicalFormat && (
                    <Group gap="xs" wrap="nowrap">
                        <Text size="xs">{snapshot.physicalFormat.value}</Text>
                        <EvidenceDot level={snapshot.physicalFormat.level} />
                    </Group>
                )}
            </Section>

            <Section
                actions={
                    <CopyButton value={report}>
                        {({ copied }) => (
                            <Text c="dim" size="xs">
                                {copied
                                    ? t('player.signalPath_copied')
                                    : t('player.signalPath_copyDiagnostics')}
                            </Text>
                        )}
                    </CopyButton>
                }
                title={t('player.signalPath_inspectorDiagnostics')}
            >
                <ScrollArea style={{ maxHeight: 200 }}>
                    <Code className={styles.report}>{report}</Code>
                </ScrollArea>
            </Section>

            <Section title={t('player.signalPath_inspectorEventLog')}>
                <Group gap="sm" wrap="nowrap">
                    <Select
                        allowDeselect={false}
                        data={CATEGORY_OPTIONS.map((option) => ({
                            label:
                                option === 'all'
                                    ? t('player.signalPath_filterAll')
                                    : t(`player.signalPath_category_${option}`),
                            value: option,
                        }))}
                        onChange={(value) =>
                            setCategoryFilter((value as 'all' | AudioEventCategory) ?? 'all')
                        }
                        size="xs"
                        value={categoryFilter}
                        w={150}
                    />
                    <Select
                        allowDeselect={false}
                        data={SEVERITY_OPTIONS.map((option) => ({
                            label:
                                option === 'all'
                                    ? t('player.signalPath_filterAll')
                                    : t(`player.signalPath_severity_${option}`),
                            value: option,
                        }))}
                        onChange={(value) =>
                            setSeverityFilter((value as 'all' | AudioEventSeverity) ?? 'all')
                        }
                        size="xs"
                        value={severityFilter}
                        w={130}
                    />
                </Group>
                <ScrollArea style={{ maxHeight: 260 }}>
                    <Stack gap={2}>
                        {filteredEvents.length === 0 && (
                            <Text c="dim" size="xs">
                                {t('player.signalPath_noEvents')}
                            </Text>
                        )}
                        {[...filteredEvents].reverse().map((event) => (
                            <Group
                                className={styles.eventRow}
                                gap="xs"
                                key={event.id}
                                wrap="nowrap"
                            >
                                <span
                                    className={`${styles.dot} ${SEVERITY_CLASS[audioEventSeverity(event.type)]}`}
                                />
                                <Text c="dim" size="xs" style={{ flexShrink: 0 }}>
                                    {dayjs(event.time).format('HH:mm:ss')}
                                </Text>
                                <Text size="xs" style={{ flexShrink: 0 }}>
                                    {t(`player.signalPath_event_${event.type.replace(/-/g, '_')}`)}
                                </Text>
                                {event.detail && (
                                    <Text c="dim" size="xs" truncate>
                                        {event.detail}
                                    </Text>
                                )}
                            </Group>
                        ))}
                    </Stack>
                </ScrollArea>
            </Section>
        </Stack>
    );
};
