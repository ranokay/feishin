import { closeModal, openModal } from '@mantine/modals';
import isElectron from 'is-electron';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { eventEmitter } from '/@/renderer/events/event-emitter';
import { UserFavoriteEventPayload, UserRatingEventPayload } from '/@/renderer/events/events';
import { DiscordRpcHook } from '/@/renderer/features/discord-rpc/use-discord-rpc';
import { MainPlayerListenerHook } from '/@/renderer/features/player/audio-player/hooks/use-main-player-listener';
import { JukeboxPlayer } from '/@/renderer/features/player/audio-player/jukebox-player';
import { MpvPlayer } from '/@/renderer/features/player/audio-player/mpv-player';
import { WebPlayer } from '/@/renderer/features/player/audio-player/web-player';
import { SleepTimerHook } from '/@/renderer/features/player/components/sleep-timer-button';
import { AutoDJHook } from '/@/renderer/features/player/hooks/use-auto-dj';
import { AutosaveHook } from '/@/renderer/features/player/hooks/use-autosave';
import { MediaSessionHook } from '/@/renderer/features/player/hooks/use-media-session';
import { MPRISHook } from '/@/renderer/features/player/hooks/use-mpris';
import { PlaybackHotkeysHook } from '/@/renderer/features/player/hooks/use-playback-hotkeys';
import { PowerSaveBlockerHook } from '/@/renderer/features/player/hooks/use-power-save-blocker';
import {
    InitialTimestampRestoreHook,
    QueueRestoreTimestampHook,
} from '/@/renderer/features/player/hooks/use-queue-restore';
import { ScrobbleHook } from '/@/renderer/features/player/hooks/use-scrobble';
import { UpdateCurrentSongHook } from '/@/renderer/features/player/hooks/use-update-current-song';
import { useWebAudio } from '/@/renderer/features/player/hooks/use-webaudio';
import { RadioWebPlayer } from '/@/renderer/features/radio/components/radio-web-player';
import {
    RadioAudioInstanceHook,
    RadioMetadataHook,
    useIsRadioActive,
    useRadioPlaybackKey,
} from '/@/renderer/features/radio/hooks/use-radio-player';
import { RemoteHook } from '/@/renderer/features/remote/hooks/use-remote';
import { VisualizerSystemAudioBridgeHook } from '/@/renderer/features/visualizer/components/visualizer-system-audio-bridge';
import {
    updateQueueFavorites,
    updateQueueRatings,
    useCurrentServerId,
    usePlaybackSettings,
    usePlaybackType,
    usePlayerActions,
    usePlayerSong,
    usePlayerStatus,
    useSettingsStore,
    useSettingsStoreActions,
} from '/@/renderer/store';
import {
    useAudioStateStore,
    useRetainedStrictPlaybackStop,
} from '/@/renderer/store/audio-state.store';
import { logger } from '/@/renderer/utils/logger';
import { ConfirmModal } from '/@/shared/components/modal/modal';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';
import {
    type PlaybackPolicyPlayerType,
    resolveFallbackPlaybackType,
    resolveStrictPlaybackStop,
    type StrictPlaybackStop,
} from '/@/shared/signalpath';
import { LibraryItem } from '/@/shared/types/domain-types';
import { PlayerStatus, PlayerType } from '/@/shared/types/types';
const CODEC_PROBES = [
    { codec: 'mp3', container: 'mp3', mime: 'audio/mpeg' },

    { codec: 'aac', container: 'mp4', mime: 'audio/mp4; codecs="mp4a.40.2"' },
    { codec: 'aac', container: 'aac', mime: 'audio/aac' },
    { codec: 'aac', container: 'mp4', mime: 'audio/x-m4a' },

    { codec: 'opus', container: 'ogg', mime: 'audio/ogg; codecs="opus"' },
    { codec: 'opus', container: 'webm', mime: 'audio/webm; codecs="opus"' },

    { codec: 'vorbis', container: 'ogg', mime: 'audio/ogg; codecs="vorbis"' },
    { codec: 'vorbis', container: 'webm', mime: 'audio/webm; codecs="vorbis"' },

    { codec: 'flac', container: 'flac', mime: 'audio/flac' },

    { codec: ['pcm', 'wav'], container: 'wav', mime: 'audio/wav' },

    { codec: 'alac', container: 'mp4', mime: 'audio/mp4; codecs="alac"' },
];

const DEFAULT_TRANSCODING_PROFILES = [
    { audioCodec: 'flac', container: 'flac', protocol: 'http' },
    { audioCodec: 'opus', container: 'ogg', protocol: 'http' },
    { audioCodec: 'mp3', container: 'mp3', protocol: 'http' },
];

const SAFARI_TRANSCODING_PROFILES = [{ audioCodec: 'mp3', container: 'mp3', protocol: 'http' }];

const DIRECT_PLAY_PROFILES: {
    audioCodecs: string[];
    containers: string[];
    protocols: string[];
}[] = [];

export function getDefaultTranscodingProfiles() {
    return isSafari() ? SAFARI_TRANSCODING_PROFILES : DEFAULT_TRANSCODING_PROFILES;
}

export function getDirectPlayProfiles() {
    return DIRECT_PLAY_PROFILES;
}

// Shamelessly taken from NavidromeUI
function detectBrowserProfile() {
    const audio = new Audio();

    for (const { codec, container, mime } of CODEC_PROBES) {
        if (audio.canPlayType(mime) === 'maybe' || audio.canPlayType(mime) === 'probably') {
            DIRECT_PLAY_PROFILES.push({
                audioCodecs: Array.isArray(codec) ? codec : [codec],
                containers: [container],
                protocols: ['http'],
            });
        }
    }

    logger.debug('DIRECT_PLAY_PROFILES', DIRECT_PLAY_PROFILES);

    return DIRECT_PLAY_PROFILES;
}

function isSafari() {
    const ua = navigator.userAgent;
    return ua.includes('Safari') && !ua.includes('Chrome') && !ua.includes('Chromium');
}

export const AudioPlayers = () => {
    const playbackType = usePlaybackType();
    const serverId = useCurrentServerId();
    const { resetSampleRate } = useSettingsStoreActions();

    const {
        audioDeviceId,
        mpvProperties: { audioSampleRateHz },
        playbackPolicy,
        webAudio,
    } = usePlaybackSettings();
    const { setWebAudio, webAudio: audioContext } = useWebAudio();
    const [fallbackRequested, setFallbackRequested] = useState(false);
    const activePlaybackType = resolveFallbackPlaybackType(
        playbackPolicy,
        playbackType,
        fallbackRequested,
    );

    useEffect(() => {
        detectBrowserProfile();
    }, []);

    useEffect(() => {
        const retryLocalPlayer = () => setFallbackRequested(false);
        eventEmitter.on('MPV_RELOAD', retryLocalPlayer);
        return () => eventEmitter.off('MPV_RELOAD', retryLocalPlayer);
    }, []);

    useEffect(() => {
        setFallbackRequested(false);
    }, [playbackType]);

    return (
        <>
            <SleepTimerHook />
            <ScrobbleHook />
            <PowerSaveBlockerHook />
            <DiscordRpcHook />
            <MPRISHook />
            <MainPlayerListenerHook />
            <MediaSessionHook />
            <PlaybackHotkeysHook />
            <RemoteHook />
            <AutoDJHook />
            <QueueRestoreTimestampHook />
            <InitialTimestampRestoreHook />
            <UpdateCurrentSongHook />
            <RadioAudioInstanceHook playbackType={activePlaybackType} />
            <RadioMetadataHook playbackType={activePlaybackType} />
            <VisualizerSystemAudioBridgeHook />
            <AutosaveHook />
            <StrictPlaybackGuard fallbackRequested={fallbackRequested} />
            <AudioPlayersContent
                audioContext={audioContext}
                audioDeviceId={audioDeviceId}
                audioSampleRateHz={audioSampleRateHz}
                playbackPolicy={playbackPolicy}
                playbackType={activePlaybackType}
                resetSampleRate={resetSampleRate}
                serverId={serverId}
                setFallbackRequested={setFallbackRequested}
                setWebAudio={setWebAudio}
                webAudio={webAudio}
            />
        </>
    );
};

const mpvPlayerListener = isElectron() ? window.api.mpvPlayerListener : null;
const STRICT_PLAYBACK_STOP_MODAL_ID = 'strict-playback-stop';
const STRICT_PLAYBACK_STOP_MESSAGE_KEYS = {
    'device-lost': 'error.strictPlaybackStopDeviceLost',
    'exclusive-contention': 'error.strictPlaybackStopExclusiveContention',
    'player-fallback': 'error.strictPlaybackStopPlayerFallback',
    'transcode-detected': 'error.strictPlaybackStopTranscoded',
    unknown: 'error.strictPlaybackStopUnknown',
    'unsupported-format': 'error.strictPlaybackStopUnsupportedFormat',
    'unsupported-rate': 'error.strictPlaybackStopUnsupportedRate',
} as const satisfies Record<StrictPlaybackStop['cause'], string>;
const LOCAL_PLAYER_FALLBACK_STOP: StrictPlaybackStop = {
    cause: 'player-fallback',
    detail: 'local player fallback requested',
    standardWouldHelp: true,
};

const StrictPlaybackGuard = ({ fallbackRequested }: { fallbackRequested: boolean }) => {
    const { t } = useTranslation();
    const retainedStop = useRetainedStrictPlaybackStop();
    const currentSong = usePlayerSong();
    const playerStatus = usePlayerStatus();
    const radioPlaybackKey = useRadioPlaybackKey();
    const { playbackPolicy, type: playbackType } = usePlaybackSettings();
    const { mediaPause, mediaPlay } = usePlayerActions();
    const { setSettings } = useSettingsStoreActions();
    const clearStrictPlaybackStop = useAudioStateStore((state) => state.clearStrictPlaybackStop);
    const syncPlaybackKey = useAudioStateStore((state) => state.syncPlaybackKey);
    const handledStop = useRef<null | string>(null);
    const playbackKey = radioPlaybackKey ?? currentSong?._uniqueId ?? null;
    const strictPlaybackState = retainedStop?.playbackKey === playbackKey ? retainedStop : null;
    const stop = useMemo(
        () =>
            resolveStrictPlaybackStop(playbackPolicy, playbackType, strictPlaybackState) ??
            (fallbackRequested &&
            playbackPolicy === 'bit-perfect' &&
            playbackType === PlayerType.LOCAL
                ? LOCAL_PLAYER_FALLBACK_STOP
                : null),
        [fallbackRequested, playbackPolicy, playbackType, strictPlaybackState],
    );
    const stopCause = stop?.cause;
    const stopDetail = stop?.detail;
    const standardWouldHelp = stop?.standardWouldHelp;

    useEffect(() => {
        syncPlaybackKey(playbackKey);
    }, [playbackKey, syncPlaybackKey]);

    useEffect(() => {
        if (playbackPolicy !== 'bit-perfect' || playbackType !== PlayerType.LOCAL) {
            clearStrictPlaybackStop();
        }
        if (!stop || !stopCause) {
            if (handledStop.current !== null) {
                closeModal(STRICT_PLAYBACK_STOP_MODAL_ID);
            }
            handledStop.current = null;
            return;
        }
        if (playerStatus === PlayerStatus.PLAYING) {
            mediaPause();
        }
        const key = `${stopCause}:${stopDetail ?? ''}`;
        if (handledStop.current === key) {
            return;
        }
        handledStop.current = key;

        logger.warn('Bit-Perfect playback stopped', { cause: stopCause });

        openModal({
            children: (
                <ConfirmModal
                    disabled={!standardWouldHelp}
                    labels={{
                        cancel: t('common.stop'),
                        confirm: t('error.strictPlaybackContinueStandard'),
                    }}
                    onCancel={() => closeModal(STRICT_PLAYBACK_STOP_MODAL_ID)}
                    onConfirm={() => {
                        closeModal(STRICT_PLAYBACK_STOP_MODAL_ID);
                        setSettings({ playback: { playbackPolicy: 'standard' } });
                        mediaPlay();
                    }}
                >
                    <Stack gap="xs">
                        <Text>{t(STRICT_PLAYBACK_STOP_MESSAGE_KEYS[stopCause])}</Text>
                        <Text>
                            {standardWouldHelp
                                ? t('error.strictPlaybackStopCanContinue')
                                : t('error.strictPlaybackStopCannotContinue')}
                        </Text>
                    </Stack>
                </ConfirmModal>
            ),
            closeOnClickOutside: false,
            modalId: STRICT_PLAYBACK_STOP_MODAL_ID,
            title: t('error.strictPlaybackStopTitle'),
        });
    }, [
        clearStrictPlaybackStop,
        mediaPause,
        mediaPlay,
        playbackPolicy,
        playbackType,
        playerStatus,
        setSettings,
        standardWouldHelp,
        stop,
        stopCause,
        stopDetail,
        t,
    ]);

    return null;
};

const AudioPlayersContent = ({
    audioContext,
    audioDeviceId,
    audioSampleRateHz,
    playbackPolicy,
    playbackType,
    resetSampleRate,
    serverId,
    setFallbackRequested,
    setWebAudio,
    webAudio,
}: {
    audioContext: ReturnType<typeof useWebAudio>['webAudio'];
    audioDeviceId: null | string | undefined;
    audioSampleRateHz: number | undefined;
    playbackPolicy: ReturnType<typeof usePlaybackSettings>['playbackPolicy'];
    playbackType: PlaybackPolicyPlayerType;
    resetSampleRate: ReturnType<typeof useSettingsStoreActions>['resetSampleRate'];
    serverId: null | string;
    setFallbackRequested: (requested: boolean) => void;
    setWebAudio: ReturnType<typeof useWebAudio>['setWebAudio'];
    webAudio: boolean;
}) => {
    const isRadioActive = useIsRadioActive();

    useEffect(() => {
        logger.info('Playback engine', { playbackType });
    }, [playbackType]);

    useEffect(() => {
        if (!mpvPlayerListener) {
            return;
        }

        return mpvPlayerListener.rendererPlayerFallback((isFallback: boolean) => {
            setFallbackRequested(isFallback);
            if (isFallback && playbackPolicy === 'bit-perfect') {
                logger.warn('Blocked WebPlayer fallback under Bit-Perfect policy');
            } else if (isFallback) {
                logger.warn('Playback engine fell back to web');
            } else {
                logger.info('Playback engine using local (mpv)');
            }
        });
    }, [playbackPolicy, setFallbackRequested]);

    useEffect(() => {
        if (playbackType !== PlayerType.WEB || !webAudio || !('AudioContext' in window)) {
            return;
        }

        let context: AudioContext;

        try {
            context = new AudioContext({
                latencyHint: 'playback',
                sampleRate: audioSampleRateHz || undefined,
            });
        } catch (error) {
            // In practice, this should never be hit because the UI should validate
            // the range. However, the actual supported range is not guaranteed
            toast.error({ message: (error as Error).message });
            context = new AudioContext({ latencyHint: 'playback' });
            resetSampleRate();
        }

        const gains = [context.createGain(), context.createGain()];

        // Build DSP chain from persisted settings so EQ/compressor
        // are active immediately on first playback, not just after
        // the user opens the settings panel.
        const { compressor, equalizer } = useSettingsStore.getState().playback;

        // Preamp gain — converts dB to linear
        const preampGain = context.createGain();
        preampGain.gain.value = equalizer.enabled ? Math.pow(10, equalizer.preamp / 20) : 1;

        // One peaking BiquadFilterNode per EQ band
        const eqFilters: BiquadFilterNode[] = equalizer.bands.map((band) => {
            const filter = context.createBiquadFilter();
            filter.type = 'peaking';
            filter.frequency.value = band.freq;
            // Q of 1.41 gives roughly 1-octave bandwidth per band
            filter.Q.value = 1.41;
            filter.gain.value = equalizer.enabled ? band.gain : 0;
            return filter;
        });

        // DynamicsCompressorNode — always present, pass-through when disabled
        // (ratio=1, threshold=0 = mathematically transparent)
        const compressorNode = context.createDynamicsCompressor();
        if (compressor.enabled) {
            compressorNode.threshold.value = compressor.threshold;
            compressorNode.ratio.value = compressor.ratio;
            compressorNode.attack.value = compressor.attack / 1000;
            compressorNode.release.value = compressor.release / 1000;
            compressorNode.knee.value = compressor.knee;
        } else {
            compressorNode.threshold.value = 0;
            compressorNode.ratio.value = 1;
            compressorNode.attack.value = 0;
            compressorNode.release.value = 0.25;
            compressorNode.knee.value = 0;
        }

        // Wire: each gain → preamp → eq[0] → eq[1] → ... → compressor → destination
        for (const gain of gains) {
            gain.connect(preampGain);
        }

        if (eqFilters.length > 0) {
            preampGain.connect(eqFilters[0]);
            for (let i = 0; i < eqFilters.length - 1; i++) {
                eqFilters[i].connect(eqFilters[i + 1]);
            }
            eqFilters[eqFilters.length - 1].connect(compressorNode);
        } else {
            preampGain.connect(compressorNode);
        }

        compressorNode.connect(context.destination);

        setWebAudio?.({
            context,
            dsp: { compressor: compressorNode, eqFilters, preampGain },
            gains,
        });

        return () => {
            void context.close().catch(() => {});
            setWebAudio?.(undefined);
        };

        // Intentionally ignore the sample rate dependency, as it makes things really messy
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [playbackType, webAudio]);

    useEffect(() => {
        if (!audioContext?.context) return undefined;
        const ctx = audioContext.context;
        if (ctx.state === 'running') return undefined;

        const unlock = () => {
            ctx.resume().catch(() => {});
        };

        document.addEventListener('pointerdown', unlock, { capture: true, once: true });
        document.addEventListener('keydown', unlock, { capture: true, once: true });

        return () => {
            document.removeEventListener('pointerdown', unlock, { capture: true });
            document.removeEventListener('keydown', unlock, { capture: true });
        };
    }, [audioContext]);

    useEffect(() => {
        // Not standard, just used in chromium-based browsers. See
        // https://developer.chrome.com/blog/audiocontext-setsinkid/.

        if (!isElectron()) {
            return;
        }

        if (playbackType !== PlayerType.WEB) {
            return;
        }

        if (audioContext && 'setSinkId' in audioContext.context && audioDeviceId) {
            const setSink = async () => {
                try {
                    if (audioContext.context.state !== 'closed') {
                        await (audioContext.context as any).setSinkId(audioDeviceId);
                    }
                } catch (error) {
                    toast.error({ message: `Error setting sink: ${(error as Error).message}` });
                }
            };

            setSink();
        }
    }, [audioContext, audioDeviceId, playbackType]);

    // Listen to favorite and rating events to update queue songs
    useEffect(() => {
        const handleFavorite = (payload: UserFavoriteEventPayload) => {
            if (payload.itemType !== LibraryItem.SONG || payload.serverId !== serverId) {
                return;
            }

            updateQueueFavorites(payload.id, payload.favorite);
        };

        const handleRating = (payload: UserRatingEventPayload) => {
            if (payload.itemType !== LibraryItem.SONG || payload.serverId !== serverId) {
                return;
            }

            updateQueueRatings(payload.id, payload.rating);
        };

        eventEmitter.on('USER_FAVORITE', handleFavorite);
        eventEmitter.on('USER_RATING', handleRating);

        return () => {
            eventEmitter.off('USER_FAVORITE', handleFavorite);
            eventEmitter.off('USER_RATING', handleRating);
        };
    }, [serverId]);

    if (playbackType === PlayerType.LOCAL) {
        return <MpvPlayer />;
    }

    if (playbackType === PlayerType.WEB) {
        if (isRadioActive) {
            return <RadioWebPlayer />;
        }

        return <WebPlayer />;
    }

    if (playbackType === PlayerType.JUKEBOX) {
        return <JukeboxPlayer />;
    }

    return null;
};
