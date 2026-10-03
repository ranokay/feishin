import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { EvidenceDot, formatServerStage, StageRow } from './signal-path-rows';
import styles from './stream-inspector-modal.module.css';

import { useAudioSnapshot } from '/@/renderer/store/audio-state.store';
import { usePlayerSong } from '/@/renderer/store/player.store';
import { useEffectivePlaybackPolicy, useSettingsStore } from '/@/renderer/store/settings.store';
import { logger } from '/@/renderer/utils/logger';
import { Button } from '/@/shared/components/button/button';
import { Code } from '/@/shared/components/code/code';
import { CopyButton } from '/@/shared/components/copy-button/copy-button';
import { Group } from '/@/shared/components/group/group';
import { ScrollArea } from '/@/shared/components/scroll-area/scroll-area';
import { Select } from '/@/shared/components/select/select';
import { Stack } from '/@/shared/components/stack/stack';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { Text } from '/@/shared/components/text/text';
import {
    AUDIO_EVENT_CATEGORIES,
    AUDIO_EVENT_SEVERITIES,
    type AudioEngineEvent,
    type AudioEngineEventType,
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
    const sourceDecode = useSettingsStore((state) => state.playback.sourceDecode);
    const policy = useEffectivePlaybackPolicy();
    const replayGainMode = useSettingsStore((state) => state.playback.mpvProperties.replayGainMode);
    const song = usePlayerSong();
    const snapshot = useAudioSnapshot();
    // The event log is fetched on demand; snapshot broadcasts that carry no new
    // event must not trigger an IPC round trip and a re-render.
    const lastEventId = snapshot?.lastEventId;

    const [events, setEvents] = useState<AudioEngineEvent[]>([]);
    const [categoryFilter, setCategoryFilter] = useState<'all' | AudioEventCategory>('all');
    const [severityFilter, setSeverityFilter] = useState<'all' | AudioEventSeverity>('all');
    const [searchFilter, setSearchFilter] = useState('');
    const loadGeneration = useRef(0);

    const loadEvents = useCallback(() => {
        if (!window.api?.audioState?.getEvents) {
            return;
        }
        loadGeneration.current += 1;
        const generation = loadGeneration.current;
        window.api.audioState
            .getEvents()
            .then((next) => {
                // Discard a response that raced a clear or a newer request.
                if (generation === loadGeneration.current) {
                    setEvents(next);
                }
            })
            .catch((error) => logger.warn('Failed to load audio engine event log', { error }));
    }, []);

    useEffect(() => {
        loadEvents();
    }, [lastEventId, loadEvents]);

    const source = useMemo(
        () =>
            declareSource({
                bitDepth: song?.bitDepth ?? null,
                channels: song?.channels ?? null,
                container: song?.container ?? null,
                sampleRate: song?.sampleRate ?? null,
                tags: song?.tags ?? null,
            }),
        [song?.bitDepth, song?.channels, song?.container, song?.sampleRate, song?.tags],
    );

    const model = useMemo(
        () => buildSignalPathModel({ policy, replayGainMode, snapshot, source, sourceDecode }),
        [policy, replayGainMode, snapshot, source, sourceDecode],
    );

    const report = useMemo(
        () => buildDiagnosticsReport({ events, policy, replayGainMode, snapshot, source }),
        [events, policy, replayGainMode, snapshot, source],
    );

    const eventLabel = useCallback(
        (type: AudioEngineEventType) => t(`player.signalPath_event_${type.replace(/-/g, '_')}`),
        [t],
    );

    const filteredEvents = useMemo(
        () =>
            filterAudioEvents(events, {
                category: categoryFilter,
                labelFor: eventLabel,
                search: searchFilter,
                severity: severityFilter,
            }),
        [categoryFilter, eventLabel, events, searchFilter, severityFilter],
    );

    if (playbackType !== PlayerType.LOCAL) {
        return (
            <Text c="dim" size="sm">
                {t('player.signalPath_inspectorLocalOnly')}
            </Text>
        );
    }

    const clearEvents = () => {
        if (!window.api?.audioState?.clearEvents) {
            return;
        }
        // Invalidate in-flight fetches: their results predate the clear.
        loadGeneration.current += 1;
        const generation = loadGeneration.current;
        window.api.audioState
            .clearEvents()
            .then(() => {
                if (generation === loadGeneration.current) {
                    setEvents([]);
                } else {
                    // A newer event landed and reloaded the log while the clear
                    // was in flight; it must not be wiped.
                    loadEvents();
                }
            })
            .catch((error) => logger.warn('Failed to clear audio engine event log', { error }));
    };

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
                {model.deviceVolume && (
                    <StageRow
                        item={model.deviceVolume}
                        label={t('player.signalPath_stageDeviceVolume')}
                    />
                )}
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
                    <TextInput
                        onChange={(event) => setSearchFilter(event.currentTarget.value)}
                        placeholder={t('player.signalPath_searchEvents')}
                        size="xs"
                        style={{ flex: 1 }}
                        value={searchFilter}
                    />
                    <Button
                        disabled={events.length === 0}
                        onClick={clearEvents}
                        size="xs"
                        variant="subtle"
                    >
                        {t('player.signalPath_clearEvents')}
                    </Button>
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
                                    {eventLabel(event.type)}
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
