import type { Album, Song } from '/@/shared/types/domain-types';

import { useQueryClient } from '@tanstack/react-query';
import isElectron from 'is-electron';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { albumQueries } from '/@/renderer/features/albums/api/album-api';
import { openTrackAnalysis } from '/@/renderer/features/player/components/track-analysis-modal';
import { useCurrentServer } from '/@/renderer/store';
import { ContextMenu } from '/@/shared/components/context-menu/context-menu';
import { toast } from '/@/shared/components/toast/toast';

interface AnalyzeActionProps {
    albums?: Album[];
    disabled?: boolean;
    songs?: Song[];
}

/**
 * Opens the offline analysis panel for the given tracks, or for the songs of
 * the given albums (their details are fetched through the album query cache).
 */
export const AnalyzeAction = ({ albums, disabled, songs }: AnalyzeActionProps) => {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const server = useCurrentServer();
    const [loading, setLoading] = useState(false);

    const hasTargets = (albums?.length ?? 0) > 0 || (songs?.length ?? 0) > 0;

    const onSelect = useCallback(async () => {
        if (songs && songs.length > 0) {
            openTrackAnalysis(songs);
            return;
        }
        if (!albums || albums.length === 0 || !server) {
            return;
        }

        setLoading(true);
        try {
            const results = await Promise.allSettled(
                albums.map((album) =>
                    queryClient.ensureQueryData(
                        albumQueries.detail({
                            query: { id: album.id },
                            serverId: album._serverId ?? server.id,
                        }),
                    ),
                ),
            );
            const albumSongs = results.flatMap((result) =>
                result.status === 'fulfilled' ? (result.value?.songs ?? []) : [],
            );
            if (albumSongs.length === 0) {
                toast.warn({ message: t('player.analysis_noTracks') });
                return;
            }
            if (results.some((result) => result.status === 'rejected')) {
                toast.warn({ message: t('player.analysis_partialAlbumLoad') });
            }
            openTrackAnalysis(albumSongs);
        } catch (error) {
            toast.error({
                message: error instanceof Error ? error.message : t('error.openError'),
                title: t('error.openError'),
            });
        } finally {
            setLoading(false);
        }
    }, [albums, queryClient, server, songs, t]);

    if (!isElectron() || !window.api?.analysis) {
        return null;
    }

    return (
        <ContextMenu.Item
            disabled={disabled || loading || !hasTargets}
            leftIcon="audioLines"
            onSelect={onSelect}
        >
            {t('page.contextMenu.analyze')}
        </ContextMenu.Item>
    );
};
