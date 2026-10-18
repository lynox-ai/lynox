/**
 * Input-side arguments for every ffmpeg / ffprobe call whose input file holds bytes from
 * outside: an upload, a voice message, a file from the tenant's area. They go BEFORE `-i`
 * (ffprobe: before the file), because both are input options.
 *
 * ffmpeg chooses the demuxer by content, whatever the file is called, and some demuxers read
 * a LIST of further files or URLs: HLS, DASH, IMF, ffconcat, image sequences. What such a list
 * may reach depends on the ffmpeg version and its defaults; HLS, for one, admits a local
 * segment whose extension is on its `allowed_extensions` list. These arguments refuse every
 * list-reading form, independently of the version and its defaults:
 *   - `-protocol_whitelist file,pipe` — no network protocol, nested or not;
 *   - `-format_whitelist` — only single-file containers and codecs, so no list-reading
 *     demuxer is ever chosen.
 */

/**
 * The demuxers ffmpeg may pick for an input (`-format_whitelist`). Only single-file containers
 * and codecs are named here. Checked against the image's ffmpeg (5.1): each of mp4, mov, m4a,
 * mkv, webm, avi, ts, mpg, flv, gif, mp3, wav, ogg, opus, flac, aac, wma, aiff, au, wv, ac3,
 * eac3, dv, raw h264, hevc, m2v and m4v, png, jpg, bmp and tiff decodes with this list,
 * detected by content; an HLS, DASH or ffconcat input is refused.
 */
export const INPUT_DEMUXERS: readonly string[] = Object.freeze([
  'mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'matroska', 'webm', 'avi', 'mpegts', 'mpeg', 'flv',
  'asf', 'gif', 'mp3', 'wav', 'w64', 'ogg', 'flac', 'aac', 'amr', 'aiff', 'caf',
  'png_pipe', 'jpeg_pipe', 'webp_pipe', 'bmp_pipe', 'tiff_pipe',
  'ac3', 'eac3', 'wv', 'ape', 'au', 'dv', 'h264', 'hevc', 'mpegvideo', 'm4v',
]);

/** The arguments themselves, in order, for splicing in before `-i` / the input file. */
export const INPUT_GUARD_ARGS: readonly string[] = Object.freeze([
  '-protocol_whitelist', 'file,pipe',
  '-format_whitelist', INPUT_DEMUXERS.join(','),
]);
