import { t } from 'i18next';
import isElectron from 'is-electron';
import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { eventEmitter } from '/@/renderer/events/event-emitter';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import { useCurrentServer, usePlayerStatus } from '/@/renderer/store';
import {
    usePlaybackSettings,
    usePlaybackType,
    useSettingsStoreActions,
} from '/@/renderer/store/settings.store';
import { logger } from '/@/renderer/utils/logger';
import { hasFeature } from '/@/shared/api/utils';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Group } from '/@/shared/components/group/group';
import { Select } from '/@/shared/components/select/select';
import { Switch } from '/@/shared/components/switch/switch';
import { toast } from '/@/shared/components/toast/toast';
import { normalizePlaybackPolicy, resolveDeviceProfile } from '/@/shared/signalpath';
import { ServerFeature } from '/@/shared/types/features-types';
import { PlayerStatus, PlayerType } from '/@/shared/types/types';

const ipc = isElectron() ? window.api.ipc : null;
const mpvPlayer = isElectron() ? window.api.mpvPlayer : null;

const getAudioDevices = async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return (devices || []).filter((dev: MediaDeviceInfo) => dev.kind === 'audiooutput');
};

export const getMpvAudioDevices = async () => {
    if (!mpvPlayer) {
        return [];
    }

    try {
        return await mpvPlayer.getAudioDevices();
    } catch (error) {
        logger.error('Failed to get MPV audio devices:', error);
        return [];
    }
};

export type AudioDeviceOption = { description?: string; label: string; value: string };

export const getDefaultAudioDevice = (
    devices: AudioDeviceOption[],
    playbackType: PlayerType,
): null | string => {
    const defaultId = playbackType === PlayerType.LOCAL ? 'auto' : 'default';
    return devices.find((d) => d.value === defaultId)?.value ?? devices[0]?.value ?? null;
};

/**
 * Picking a device must persist its description too: mpv device ids are not
 * stable across replug, so the description is the profile fallback key.
 */
export const resolveAudioDeviceSettings = (
    playbackType: PlayerType,
    devices: AudioDeviceOption[],
    deviceId: null | string,
):
    | { audioDeviceId: null | string }
    | {
          mpvAudioDeviceDescription: null | string;
          mpvAudioDeviceId: null | string;
      } => {
    if (playbackType !== PlayerType.LOCAL) {
        return { audioDeviceId: deviceId };
    }
    return {
        mpvAudioDeviceDescription:
            devices.find((device) => device.value === deviceId)?.description ?? null,
        mpvAudioDeviceId: deviceId,
    };
};

export const useAudioDevices = (playbackType: PlayerType) => {
    const [audioDevices, setAudioDevices] = useState<AudioDeviceOption[]>([]);

    useEffect(() => {
        const fetchAudioDevices = async () => {
            if (!isElectron()) {
                return;
            }

            if (playbackType === PlayerType.WEB) {
                getAudioDevices()
                    .then((dev) => {
                        const uniqueDevices = dev.filter(
                            (d, index, self) =>
                                index === self.findIndex((t) => t.deviceId === d.deviceId),
                        );
                        setAudioDevices(
                            uniqueDevices.map((d) => ({ label: d.label, value: d.deviceId })),
                        );
                    })
                    .catch(() =>
                        toast.error({
                            message: t('error.audioDeviceFetchError'),
                        }),
                    );
            } else if (playbackType === PlayerType.LOCAL && mpvPlayer) {
                try {
                    const devices = await getMpvAudioDevices();
                    const uniqueDevices = devices.filter(
                        (d, index, self) => index === self.findIndex((t) => t.value === d.value),
                    );
                    setAudioDevices(uniqueDevices);
                } catch {
                    toast.error({
                        message: t('error.audioDeviceFetchError'),
                    });
                }
            }
        };

        fetchAudioDevices();
    }, [playbackType]);

    return audioDevices;
};

export const AudioSettings = memo(() => {
    const { t } = useTranslation();
    const settings = usePlaybackSettings();
    const { setPlaybackDeviceProfile, setSettings } = useSettingsStoreActions();
    const status = usePlayerStatus();
    const playbackType = usePlaybackType();
    const { mediaStop } = usePlayer();

    // Cleaned up server feature logic via requested hooks/utilities
    const currentServer = useCurrentServer();
    const isJukeboxSupported = hasFeature(currentServer, ServerFeature.JUKEBOX);
    const showRefreshButton = settings.type === PlayerType.LOCAL;

    const audioDevices = useAudioDevices(playbackType);
    const audioDeviceId =
        playbackType === PlayerType.LOCAL ? settings.mpvAudioDeviceId : settings.audioDeviceId;
    // The picker shows mpv's autoselect device when nothing is persisted, so a
    // profile can attach to that displayed device without a prior pick.
    const selectedDeviceId = audioDeviceId ?? getDefaultAudioDevice(audioDevices, playbackType);
    const audioDeviceDescription =
        audioDevices.find((device) => device.value === selectedDeviceId)?.description ??
        settings.mpvAudioDeviceDescription ??
        null;
    const deviceProfile =
        playbackType === PlayerType.LOCAL && selectedDeviceId
            ? resolveDeviceProfile(
                  settings.deviceProfiles,
                  selectedDeviceId,
                  audioDeviceDescription,
              )
            : null;

    // Dynamically build the options for the dropdown
    const selectData = [
        {
            disabled: !isElectron(),
            label: 'MPV',
            value: PlayerType.LOCAL,
        },
        { label: 'Web', value: PlayerType.WEB },
    ];

    if (isJukeboxSupported) {
        selectData.push({ label: 'Jukebox', value: PlayerType.JUKEBOX });
    }

    const audioOptions: SettingOption[] = [
        {
            control: (
                <Group gap="xs" wrap="nowrap">
                    <Select
                        data={selectData}
                        defaultValue={settings.type}
                        disabled={status === PlayerStatus.PLAYING}
                        onChange={(e) => {
                            setSettings({ playback: { type: e as PlayerType } });
                            ipc?.send('settings-set', { property: 'playbackType', value: e });
                        }}
                    />
                    {showRefreshButton && (
                        <ActionIcon
                            icon="refresh"
                            iconProps={{ size: 'md' }}
                            onClick={() => {
                                mediaStop();
                                eventEmitter.emit('MPV_RELOAD', {});
                            }}
                            tooltip={{ label: t('common.reload') }}
                            variant="transparent"
                        />
                    )}
                </Group>
            ),
            description: t('setting.audioPlayer', { context: 'description' }),
            isHidden: !isElectron() && !isJukeboxSupported,
            note: status === PlayerStatus.PLAYING ? t('common.playerMustBePaused') : undefined,
            title: t('setting.audioPlayer'),
        },
        {
            control: (
                <Select
                    clearable
                    data={audioDevices}
                    disabled={!isElectron()}
                    onChange={(e) =>
                        setSettings({
                            playback: resolveAudioDeviceSettings(playbackType, audioDevices, e),
                        })
                    }
                    value={selectedDeviceId}
                />
            ),
            description: t('setting.audioDevice', { context: 'description' }),
            isHidden: !isElectron(),
            title: t('setting.audioDevice'),
        },
        {
            control: (
                <Select
                    data={[
                        {
                            label: t('setting.devicePlaybackPolicy', { context: 'optionGlobal' }),
                            value: 'global',
                        },
                        {
                            label: t('setting.playbackPolicy', { context: 'optionStandard' }),
                            value: 'standard',
                        },
                        {
                            label: t('setting.playbackPolicy', { context: 'optionExclusive' }),
                            value: 'exclusive',
                        },
                        {
                            label: t('setting.playbackPolicy', { context: 'optionBitPerfect' }),
                            value: 'bit-perfect',
                        },
                    ]}
                    onChange={(e) => {
                        if (!selectedDeviceId || !e) {
                            return;
                        }
                        const profileKey = deviceProfile?.key ?? selectedDeviceId;
                        if (e === 'global') {
                            setPlaybackDeviceProfile(profileKey, null);
                            return;
                        }
                        setPlaybackDeviceProfile(profileKey, {
                            description: audioDeviceDescription,
                            policyOverride: normalizePlaybackPolicy(e),
                        });
                    }}
                    value={deviceProfile?.profile.policyOverride ?? 'global'}
                />
            ),
            description: t('setting.devicePlaybackPolicy', { context: 'description' }),
            isHidden: !isElectron() || playbackType !== PlayerType.LOCAL || !selectedDeviceId,
            title: t('setting.devicePlaybackPolicy'),
        },
        {
            control: (
                <Switch
                    defaultChecked={settings.webAudio}
                    onChange={(e) => {
                        setSettings({
                            playback: { webAudio: e.currentTarget.checked },
                        });
                    }}
                />
            ),
            description: t('setting.webAudio', { context: 'description' }),
            isHidden: settings.type !== PlayerType.WEB,
            note: t('common.restartRequired'),
            title: t('setting.webAudio'),
        },
        {
            control: (
                <Switch
                    defaultChecked={settings.preservePitch}
                    onChange={(e) => {
                        setSettings({
                            playback: { preservePitch: e.currentTarget.checked },
                        });
                    }}
                />
            ),
            description: t('setting.preservePitch', { context: 'description' }),
            isHidden: settings.type !== PlayerType.WEB,
            title: t('setting.preservePitch'),
        },
        {
            control: (
                <Switch
                    defaultChecked={settings.audioFadeOnStatusChange}
                    onChange={(e) => {
                        setSettings({
                            playback: { audioFadeOnStatusChange: e.currentTarget.checked },
                        });
                    }}
                />
            ),
            description: t('setting.audioFadeOnStatusChange', { context: 'description' }),
            title: t('setting.audioFadeOnStatusChange'),
        },
    ];

    return <SettingsSection options={audioOptions} title={t('page.setting.audio')} />;
});
