import type { RefObject } from 'react';

import isElectron from 'is-electron';
import { useEffect, useImperativeHandle, useRef, useState } from 'react';

import { eventEmitter } from '/@/renderer/events/event-emitter';
import { usePlayerEvents } from '/@/renderer/features/player/audio-player/hooks/use-player-events';
import { getMpvStream } from '/@/renderer/features/player/audio-player/hooks/use-stream-url';
import { AudioPlayer, PlayerOnProgressProps } from '/@/renderer/features/player/audio-player/types';
import { useRadioStore } from '/@/renderer/features/radio/hooks/use-radio-player';
import { getMpvProperties } from '/@/renderer/features/settings/components/playback/mpv-properties';
import {
    usePlaybackSettings,
    usePlayerActions,
    usePlayerSong,
    usePlayerStore,
    useSettingsStore,
} from '/@/renderer/store';
import {
    filterPolicyExtraParameters,
    type Platform,
    policyStartupConfig,
} from '/@/shared/signalpath';
import { PlayerStatus } from '/@/shared/types/types';

export interface MpvPlayerEngineHandle extends AudioPlayer {}

interface MpvPlayerEngineProps {
    isMuted: boolean;
    isTransitioning: boolean;
    onEnded: () => void;
    onProgress: (e: PlayerOnProgressProps) => void;
    playerRef: RefObject<MpvPlayerEngineHandle | null>;
    playerStatus: PlayerStatus;
    preservePitch?: boolean;
    speed?: number;
    volume: number;
}

const mpvPlayer = isElectron() ? window.api.mpvPlayer : null;
const mpvPlayerListener = isElectron() ? window.api.mpvPlayerListener : null;
const ipc = isElectron() ? window.api.ipc : null;

const PROGRESS_UPDATE_INTERVAL = 250;

export const MpvPlayerEngine = (props: MpvPlayerEngineProps) => {
    const {
        isMuted,
        isTransitioning,
        onEnded,
        onProgress,
        playerRef,
        playerStatus,
        preservePitch,
        speed,
        volume,
    } = props;

    const [internalVolume, setInternalVolume] = useState(volume / 100 || 0);
    const currentSong = usePlayerSong();

    const progressIntervalRef = useRef<NodeJS.Timeout | null>(null);
    const isInitializedRef = useRef<boolean>(false);
    const hasPopulatedQueueRef = useRef<boolean>(false);
    const isMountedRef = useRef<boolean>(true);

    const { mpvAudioDeviceId, transcode } = usePlaybackSettings();
    const mpvExtraParameters = useSettingsStore((store) => store.playback.mpvExtraParameters);
    const mpvProperties = useSettingsStore((store) => store.playback.mpvProperties);
    const playbackPolicy = useSettingsStore((store) => store.playback.playbackPolicy);
    const [reloadTrigger, setReloadTrigger] = useState(0);

    useEffect(() => {
        const handleMpvReload = () => {
            setReloadTrigger((prev) => prev + 1);
        };

        const handleMpvReconnect = () => {
            handleMpvReload();
        };

        eventEmitter.on('MPV_RELOAD', handleMpvReload);
        // The main process notifies us after the OS resumes from sleep, since the
        // stream mpv had open is likely on a now-dead connection.
        mpvPlayerListener?.rendererMpvReconnect(handleMpvReconnect);

        return () => {
            eventEmitter.off('MPV_RELOAD', handleMpvReload);
            ipc?.removeAllListeners('renderer-mpv-reconnect');
        };
    }, []);

    // Start the mpv instance on startup
    useEffect(() => {
        isMountedRef.current = true;

        const initializeMpv = async () => {
            // Always quit mpv first to ensure clean state, especially during HMR remounts
            const isRunning: boolean | undefined = await mpvPlayer?.isRunning();
            if (isRunning) {
                mpvPlayer?.quit();

                let attempts = 0;
                const maxAttempts = 20;
                while (attempts < maxAttempts) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                    const stillRunning = await mpvPlayer?.isRunning();
                    if (!stillRunning) {
                        break;
                    }
                    attempts++;
                }
            }

            // Reset initialization state
            isInitializedRef.current = false;
            hasPopulatedQueueRef.current = false;

            const platform: Platform = window.api?.utils?.isMacOS?.()
                ? 'darwin'
                : window.api?.utils?.isWindows?.()
                  ? 'win32'
                  : 'linux';

            // Merge the policy-derived startup config (AO pinning, exclusive
            // flags, strict pins) at the existing initialization choke point.
            // Standard resolves to empty, leaving today's arg set untouched.
            const { runtimeProperties, startupArgs } = policyStartupConfig(
                playbackPolicy,
                platform,
            );

            // Initialize mpv with fresh state. Policy-derived runtime pins go
            // last so strict values (unity gain, unit speed) win at startup.
            const properties: Record<string, any> = {
                ...getMpvProperties(mpvProperties),
                'audio-pitch-correction': preservePitch === false ? 'no' : 'yes',
                mute: isMuted,
                speed: speed,
                volume: volume,
                ...runtimeProperties,
            };

            const extraParameters: string[] = [
                ...filterPolicyExtraParameters(playbackPolicy, mpvExtraParameters),
                ...startupArgs,
            ];

            const audioDevice = mpvAudioDeviceId?.trim() || 'auto';
            extraParameters.push(`--audio-device=${audioDevice}`);

            await mpvPlayer?.initialize({
                extraParameters,
                playbackPolicy,
                properties,
            });

            // Apply EQ and compressor filters after MPV has initialized
            const { compressor, equalizer } = useSettingsStore.getState().playback;
            const { buildMpvAudioFilters } =
                await import('/@/renderer/features/settings/components/playback/mpv-audio-filters');
            const filterStr = buildMpvAudioFilters(equalizer, compressor);
            if (playbackPolicy !== 'bit-perfect' && filterStr) {
                mpvPlayer?.setProperties({ af: filterStr });
            }

            // After initialization, populate the queue if currentSrc is available
            // Don't override queue if radio is active
            const radioState = useRadioStore.getState();

            if (!radioState.currentStreamUrl) {
                const playerData = usePlayerStore.getState().getPlayerData();
                const currentStream = playerData.currentSong
                    ? await getMpvStream(playerData.currentSong, transcode)
                    : undefined;
                const nextStream = playerData.nextSong
                    ? await getMpvStream(playerData.nextSong, transcode)
                    : undefined;

                // Restore the current track even without a successor: on a
                // single-item or final queue (e.g. after a policy change
                // re-initialized mpv), requiring a next URL would leave mpv
                // empty while the player store still holds the current song.
                if (currentStream && !hasPopulatedQueueRef.current && mpvPlayer) {
                    const shouldPause =
                        usePlayerStore.getState().player.status !== PlayerStatus.PLAYING;
                    mpvPlayer.setQueue(currentStream, nextStream, shouldPause);
                    hasPopulatedQueueRef.current = true;
                }
            }

            isInitializedRef.current = true;
        };

        initializeMpv();

        return () => {
            isMountedRef.current = false;
            // Quit mpv on unmount
            mpvPlayer?.quit();
            isInitializedRef.current = false;
            hasPopulatedQueueRef.current = false;
        };
        // Note: volume, speed, preservePitch, and transcode are intentionally not in dependencies.
        // Volume speed, and preservePitch changes are handled by separate useEffects below to avoid
        // reinitializing the entire player. Transcode changes are handled by queue
        // update callbacks in usePlayerEvents.
        // reloadTrigger is included to allow manual reload via MPV_RELOAD event.
        // playbackPolicy re-initializes mpv so policy-derived args take effect.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mpvExtraParameters, mpvProperties, mpvAudioDeviceId, reloadTrigger, playbackPolicy]);

    // Update volume
    useEffect(() => {
        if (!mpvPlayer) {
            return;
        }

        const vol = volume / 100 || 0;
        queueMicrotask(() => {
            setInternalVolume(vol);
        });

        if (playbackPolicy === 'bit-perfect') {
            return;
        }

        mpvPlayer.volume(volume);
    }, [playbackPolicy, volume]);

    // Update mute status
    useEffect(() => {
        if (!mpvPlayer) {
            return;
        }

        mpvPlayer.mute(isMuted);
    }, [isMuted]);

    // Update speed/playback rate
    useEffect(() => {
        if (!mpvPlayer) {
            return;
        }

        if (!speed) {
            return;
        }

        if (playbackPolicy === 'bit-perfect') {
            return;
        }

        mpvPlayer.setProperties({ speed });
    }, [playbackPolicy, speed]);

    // Update pitch correction status
    useEffect(() => {
        if (!mpvPlayer) {
            return;
        }

        if (preservePitch === false) {
            mpvPlayer.setProperties({ 'audio-pitch-correction': 'no' });
        } else {
            mpvPlayer.setProperties({ 'audio-pitch-correction': 'yes' });
        }
    }, [preservePitch]);

    // Handle play/pause status
    useEffect(() => {
        if (!mpvPlayer) {
            return;
        }

        if (playerStatus === PlayerStatus.PLAYING) {
            mpvPlayer.play();
        } else {
            mpvPlayer.pause();
        }
    }, [playerStatus]);

    const hasCurrentSong = !!currentSong?.id;

    // Set up progress tracking
    useEffect(() => {
        if (progressIntervalRef.current) {
            clearInterval(progressIntervalRef.current);
        }

        if (!hasCurrentSong) {
            return;
        }

        if (playerStatus !== PlayerStatus.PLAYING) {
            return;
        }

        const updateProgress = async () => {
            if (!mpvPlayer || !isMountedRef.current) {
                return;
            }

            try {
                const time = await mpvPlayer.getCurrentTime();
                if (time !== undefined && isMountedRef.current) {
                    onProgress({
                        played: time / (time + 10),
                        playedSeconds: time,
                    });
                }
            } catch {
                // Handle error silently
            }
        };

        const interval = PROGRESS_UPDATE_INTERVAL;
        progressIntervalRef.current = setInterval(updateProgress, interval);
        updateProgress();

        return () => {
            isMountedRef.current = false;
            if (progressIntervalRef.current) {
                clearInterval(progressIntervalRef.current);
                progressIntervalRef.current = null;
            }
        };
    }, [hasCurrentSong, isTransitioning, onProgress, playerStatus]);

    const { mediaAutoNext } = usePlayerActions();

    useEffect(() => {
        if (!mpvPlayerListener) {
            return;
        }

        const handleOnAutoNext = () => {
            mediaAutoNext();
            handleMpvAutoNext(transcode);
        };

        const handleTrackEnded = () => {
            const { player } = usePlayerStore.getState();
            // mpv often emits `stopped` before this event, which already set STOPPED
            // via mediaStop. Still run mediaAutoNext so end-of-queue seek/reset runs.
            if (player.status !== PlayerStatus.PLAYING && player.status !== PlayerStatus.STOPPED) {
                return;
            }

            mediaAutoNext();
        };

        mpvPlayerListener.rendererAutoNext(handleOnAutoNext);
        mpvPlayerListener.rendererTrackEnded(handleTrackEnded);

        return () => {
            ipc?.removeAllListeners('renderer-player-auto-next');
            ipc?.removeAllListeners('renderer-player-track-ended');
        };
    }, [mediaAutoNext, onEnded, transcode]);

    usePlayerEvents(
        {
            onMediaNext: () => {
                replaceMpvQueue(transcode);
            },
            onMediaPrev: () => {
                replaceMpvQueue(transcode);
            },
            onNextSongInsertion: async (song) => {
                const radioState = useRadioStore.getState();

                if (radioState.currentStreamUrl) {
                    return;
                }

                const nextStream = song ? await getMpvStream(song, transcode) : undefined;
                mpvPlayer?.setQueueNext(nextStream);
            },
            onPlayerPlay: () => {
                replaceMpvQueue(transcode);
            },
            onQueueCleared: () => {},
            onQueueRestored: () => {
                replaceMpvQueue(transcode);
            },
        },
        [transcode],
    );

    useImperativeHandle<MpvPlayerEngineHandle, MpvPlayerEngineHandle>(playerRef, () => ({
        decreaseVolume(by: number) {
            if (playbackPolicy === 'bit-perfect') {
                return;
            }

            const newVol = Math.max(0, internalVolume - by / 100);
            setInternalVolume(newVol);
            if (mpvPlayer) {
                mpvPlayer.volume(newVol * 100);
            }
        },
        increaseVolume(by: number) {
            if (playbackPolicy === 'bit-perfect') {
                return;
            }

            const newVol = Math.min(1, internalVolume + by / 100);
            setInternalVolume(newVol);
            if (mpvPlayer) {
                mpvPlayer.volume(newVol * 100);
            }
        },
        pause() {
            if (mpvPlayer) {
                mpvPlayer.pause();
            }
        },
        play() {
            if (mpvPlayer) {
                mpvPlayer.play();
            }
        },
        seekTo(seekTo: number) {
            if (mpvPlayer) {
                mpvPlayer.seekTo(seekTo);
            }
        },
        setVolume(vol: number) {
            if (playbackPolicy === 'bit-perfect') {
                return;
            }

            const volDecimal = vol / 100 || 0;
            setInternalVolume(volDecimal);
            if (mpvPlayer) {
                mpvPlayer.volume(vol);
            }
        },
    }));

    return <div id="mpv-player-engine" style={{ display: 'none' }} />;
};

MpvPlayerEngine.displayName = 'MpvPlayerEngine';

async function handleMpvAutoNext(transcode: {
    bitrate?: number | undefined;
    enabled: boolean;
    format?: string | undefined;
}) {
    const playerData = usePlayerStore.getState().getPlayerData();
    const nextStream = playerData.nextSong
        ? await getMpvStream(playerData.nextSong, transcode)
        : undefined;
    mpvPlayer?.autoNext(nextStream);
}

async function replaceMpvQueue(transcode: {
    bitrate?: number | undefined;
    enabled: boolean;
    format?: string | undefined;
}) {
    // Don't override queue if radio is active
    const radioState = useRadioStore.getState();

    if (radioState.currentStreamUrl) {
        return;
    }

    const playerData = usePlayerStore.getState().getPlayerData();
    const currentStream = playerData.currentSong
        ? await getMpvStream(playerData.currentSong, transcode)
        : undefined;
    const nextStream = playerData.nextSong
        ? await getMpvStream(playerData.nextSong, transcode)
        : undefined;
    mpvPlayer?.setQueue(currentStream, nextStream, false);
}
