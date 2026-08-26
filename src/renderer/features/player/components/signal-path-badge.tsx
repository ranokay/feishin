import { openModal } from '@mantine/modals';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './signal-path-badge.module.css';
import { EvidenceDot, formatServerStage, StageRow } from './signal-path-rows';
import { StreamInspectorModal } from './stream-inspector-modal';

import { useAudioSnapshot } from '/@/renderer/store/audio-state.store';
import { usePlayerSong, usePlayerStore } from '/@/renderer/store/player.store';
import { useSettingsStore } from '/@/renderer/store/settings.store';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { Popover } from '/@/shared/components/popover/popover';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';
import {
    buildSignalPathModel,
    type ConfidenceLevel,
    declareSource,
    type IntegrityStatus,
    isExclusiveRoute,
    type ProcessingEntry,
} from '/@/shared/signalpath';
import { PlayerStatus, PlayerType } from '/@/shared/types/types';

const VERDICT_META: Record<IntegrityStatus, { className: string; key: string }> = {
    'bit-perfect-eligible': {
        className: styles.verdictEligible,
        key: 'verdictEligible',
    },
    'bit-perfect-verified': {
        className: styles.verdictVerified,
        key: 'verdictVerified',
    },
    'exclusive-processed': {
        className: styles.verdictProcessed,
        key: 'verdictExclusiveProcessed',
    },
    'lossy-source': {
        className: styles.verdictLossy,
        key: 'verdictLossy',
    },
    processed: {
        className: styles.verdictProcessed,
        key: 'verdictProcessed',
    },
    resampled: {
        className: styles.verdictResampled,
        key: 'verdictResampled',
    },
    transcoded: {
        className: styles.verdictTranscoded,
        key: 'verdictTranscoded',
    },
    unknown: {
        className: styles.verdictUnknown,
        key: 'verdictUnknown',
    },
    'unprocessed-shared': {
        className: styles.verdictShared,
        key: 'verdictShared',
    },
};

const DSP_KEY: Record<ProcessingEntry['kind'], string> = {
    'channel-map': 'dspChannelMap',
    'declared-decode': 'dspDeclaredDecode',
    filter: 'dspFilter',
    'format-conversion': 'dspFormatConversion',
    gain: 'dspGain',
    replaygain: 'dspReplaygain',
    resample: 'dspResample',
    tempo: 'dspTempo',
};

const ProcessingRow = ({
    entries,
    evidenceLevel,
}: {
    entries: ProcessingEntry[];
    evidenceLevel: ConfidenceLevel;
}) => {
    const { t } = useTranslation();

    return (
        <Group align="flex-start" gap="xs" justify="space-between" wrap="nowrap">
            <Text c="dim" size="xs" style={{ flexShrink: 0 }}>
                {t('player.signalPath_stageProcessing')}
            </Text>
            {entries.length === 0 ? (
                <Group gap="xs" wrap="nowrap">
                    <Text size="xs">{t('player.signalPath_dspNone')}</Text>
                    <EvidenceDot level={evidenceLevel} />
                </Group>
            ) : (
                <Stack gap={4}>
                    {entries.map((entry, index) => (
                        <Group gap="xs" key={`${entry.kind}-${index}`} wrap="nowrap">
                            <Text size="xs">
                                {t(`player.signalPath_${DSP_KEY[entry.kind]}`)}
                                {entry.detail ? ` (${entry.detail})` : ''}
                            </Text>
                            <EvidenceDot level={entry.level} />
                        </Group>
                    ))}
                </Stack>
            )}
        </Group>
    );
};

export const SignalPathBadge = () => {
    const { t } = useTranslation();
    const playbackType = useSettingsStore((state) => state.playback.type);
    const policy = useSettingsStore((state) => state.playback.playbackPolicy);
    const replayGainMode = useSettingsStore((state) => state.playback.mpvProperties.replayGainMode);
    const song = usePlayerSong();
    const playerStatus = usePlayerStore((state) => state.player.status);
    const snapshot = useAudioSnapshot();

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

    // Only the local mpv engine has a signal path to describe, and a stopped
    // player would keep showing the previous track's verdict indefinitely.
    if (playbackType !== PlayerType.LOCAL || !song || playerStatus === PlayerStatus.STOPPED) {
        return null;
    }

    const verdict = VERDICT_META[model.integrity.status];
    const exclusiveRequestedUnconfirmed =
        model.requestedExclusive &&
        !(model.output.value !== null && isExclusiveRoute(model.output.value));

    const openInspector = () => {
        openModal({
            children: <StreamInspectorModal />,
            size: 'lg',
            title: t('player.signalPath_inspectorTitle'),
        });
    };

    return (
        <Popover position="top-end" withArrow>
            <Popover.Target>
                <Button
                    onClick={(e) => e.stopPropagation()}
                    size="compact-xs"
                    variant="transparent"
                >
                    <span className={`${styles.dot} ${verdict.className}`} />
                    {t(`player.signalPath_${verdict.key}`)}
                </Button>
            </Popover.Target>
            <Popover.Dropdown miw={340} onClick={(e) => e.stopPropagation()} p="sm" w={420}>
                <Stack gap="sm">
                    <Text fw={600} size="sm">
                        {t('player.signalPath')}
                    </Text>
                    <StageRow item={model.source} label={t('player.signalPath_stageSource')} />
                    <StageRow
                        item={{
                            ...model.server,
                            detail: formatServerStage(snapshot?.serverRoute, t),
                        }}
                        label={t('player.signalPath_stageServer')}
                    />
                    <StageRow item={model.decoder} label={t('player.signalPath_stageDecoder')} />
                    <ProcessingRow
                        entries={model.processing}
                        evidenceLevel={model.processingEvidence}
                    />
                    <StageRow
                        item={{
                            ...model.output,
                            detail: exclusiveRequestedUnconfirmed
                                ? t('player.signalPath_exclusiveRequested')
                                : model.output.detail,
                        }}
                        label={t('player.signalPath_stageOutput')}
                    />
                    <StageRow item={model.device} label={t('player.signalPath_stageDevice')} />
                    <Button fullWidth onClick={openInspector} size="compact-xs" variant="light">
                        {t('player.signalPath_openInspector')}
                    </Button>
                </Stack>
            </Popover.Dropdown>
        </Popover>
    );
};
