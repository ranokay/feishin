/**
 * One ffmpeg pass per track: astats (peak/RMS/DC/noise floor), aspectralstats
 * rolloff printed through ametadata, ebur128 (LUFS/LRA/true peak). The filter
 * order and the parser in parse.ts are a pair; change them together.
 */
export const ANALYSIS_FILTER_CHAIN =
    'astats=metadata=0:measure_overall=all,aspectralstats=measure=rolloff:win_size=32768,ametadata=mode=print:file=-,ebur128=peak=true';

export function buildFfmpegAnalysisArgs(filePath: string): string[] {
    return [
        '-hide_banner',
        '-nostats',
        '-nostdin',
        '-i',
        filePath,
        '-af',
        ANALYSIS_FILTER_CHAIN,
        '-f',
        'null',
        '-',
    ];
}

export function buildFfprobeAnalysisArgs(filePath: string): string[] {
    return [
        '-v',
        'error',
        '-show_entries',
        'format=format_name,duration,size:stream=codec_name,codec_type,sample_rate,channels,bits_per_raw_sample,bits_per_sample,duration',
        '-of',
        'json',
        filePath,
    ];
}
