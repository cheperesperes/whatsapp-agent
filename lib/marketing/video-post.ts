/**
 * Post-render video finishing: burn brand captions + a music bed into the
 * rendered clip, then store the result in Supabase Storage and return its
 * public URL.
 *
 * Runs in the finalize-videos cron AFTER the product-integrity gate, only when
 * the clip is completed and not hard-flagged. GRACEFUL BY DESIGN: ffmpeg, the
 * bundled font, the music download, and the storage upload can each fail
 * independently — every failure path degrades (full → music-only →
 * captions-only → skip) and a skip just leaves the original Higgsfield URL in
 * place, so the pipeline never breaks.
 *
 * Music is opt-in via MARKETING_MUSIC_URL (a royalty-free track Ed supplies) —
 * unset means captions-only, never an unlicensed track.
 *
 * Brand (from the Oiikon Marketing Kit): orange #F97316 on ink #020817, white
 * text, Inter Black. No Cuba copy — caption text comes from the USA-broad
 * youtube_title the content generator already validates.
 */
import ffmpegPath from 'ffmpeg-static';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServiceClient } from '@/lib/supabase';

const execFileP = promisify(execFile);

const BRAND = {
  orange: '0xF97316',
  ink: '0x020817',
  white: 'white',
} as const;

const FONT_PATH = join(process.cwd(), 'assets', 'fonts', 'Inter-Black.ttf');
const BUCKET = process.env.MARKETING_VIDEO_BUCKET ?? 'marketing-videos';
const MUSIC_URL = process.env.MARKETING_MUSIC_URL ?? '';
const DEFAULT_DURATION = Number(process.env.HIGGSFIELD_VIDEO_DURATION ?? 5);

export interface VideoPostResult {
  ok: boolean;          // a finished file was produced and stored
  url?: string;         // public URL of the finished clip (use in place of the raw render)
  skipped: boolean;     // nothing was done → keep the original URL
  hadMusic: boolean;
  hadCaptions: boolean;
  note?: string;
}

const skip = (note: string): VideoPostResult =>
  ({ ok: false, skipped: true, hadMusic: false, hadCaptions: false, note });

async function fetchBuf(url: string, ms = 30_000): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Keep only glyphs Inter renders cleanly (Latin + accents); drop emoji/symbols. */
function sanitize(s: string): string {
  return s
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{2190}-\u{21FF}\u{2300}-\u{23FF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Greedy word-wrap to <= maxChars per line, capped at maxLines (… if clipped). */
function wrap(text: string, maxChars: number, maxLines: number): string {
  const words = sanitize(text).split(' ').filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
    if (lines.length === maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && (cur.length > maxChars || words.length > lines.join(' ').split(' ').length)) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.{1}$/, '…');
  }
  return lines.join('\n');
}

interface BuildOpts {
  videoPath: string;
  musicPath: string | null;
  headFile: string | null; // wrapped headline textfile
  ctaFile: string | null;  // CTA textfile
  durationSec: number;
  outPath: string;
}

/** Compose the ffmpeg argv for a given combination of music/captions. */
function ffmpegArgs(o: BuildOpts): string[] {
  const args = ['-y', '-i', o.videoPath];
  if (o.musicPath) args.push('-stream_loop', '-1', '-i', o.musicPath);

  const draw: string[] = [];
  if (o.headFile && existsSync(FONT_PATH)) {
    draw.push(
      `drawtext=fontfile='${FONT_PATH}':textfile='${o.headFile}':fontcolor=${BRAND.white}` +
        `:fontsize=h/15:line_spacing=12:box=1:boxcolor=${BRAND.ink}@0.6:boxborderw=28` +
        `:x=(w-text_w)/2:y=h*0.07`,
    );
  }
  if (o.ctaFile && existsSync(FONT_PATH)) {
    draw.push(
      `drawtext=fontfile='${FONT_PATH}':textfile='${o.ctaFile}':fontcolor=${BRAND.ink}` +
        `:fontsize=h/24:box=1:boxcolor=${BRAND.orange}@0.95:boxborderw=22` +
        `:x=(w-text_w)/2:y=h*0.85`,
    );
  }
  if (draw.length) args.push('-vf', draw.join(','));

  if (o.musicPath) {
    const fadeOut = Math.max(0, o.durationSec - 1);
    args.push(
      '-af',
      `volume=0.55,afade=t=in:st=0:d=0.6,afade=t=out:st=${fadeOut}:d=1`,
      '-map', '0:v', '-map', '1:a',
    );
  }

  args.push(
    '-t', String(o.durationSec),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  );
  if (o.musicPath) args.push('-c:a', 'aac', '-b:a', '128k');
  args.push(o.outPath);
  return args;
}

async function uploadToStorage(buf: Buffer, key: string): Promise<string> {
  const sb = createServiceClient();
  // Idempotent: ignore "already exists".
  await sb.storage.createBucket(BUCKET, { public: true }).catch(() => {});
  const { error } = await sb.storage
    .from(BUCKET)
    .upload(key, buf, { contentType: 'video/mp4', upsert: true });
  if (error) throw new Error(`storage upload: ${error.message}`);
  const { data } = sb.storage.from(BUCKET).getPublicUrl(key);
  if (!data?.publicUrl) throw new Error('no public URL');
  return data.publicUrl;
}

export async function finishVideo(
  videoUrl: string,
  opts: { campaignId: string; headline?: string | null; cta?: string | null; durationSec?: number },
): Promise<VideoPostResult> {
  if (!ffmpegPath) return skip('ffmpeg-static unavailable');

  const headline = opts.headline ? wrap(opts.headline, 22, 3) : '';
  const cta = opts.cta ? sanitize(opts.cta).toUpperCase().slice(0, 36) : '';
  const wantCaptions = (!!headline || !!cta) && existsSync(FONT_PATH);
  const wantMusic = !!MUSIC_URL;
  if (!wantCaptions && !wantMusic) return skip('nothing to add (no music url, no font/captions)');

  const dir = await mkdtemp(join(tmpdir(), 'vidpost-'));
  try {
    const videoPath = join(dir, 'in.mp4');
    await writeFile(videoPath, await fetchBuf(videoUrl));

    let musicPath: string | null = null;
    if (wantMusic) {
      try {
        musicPath = join(dir, 'music');
        await writeFile(musicPath, await fetchBuf(MUSIC_URL));
      } catch {
        musicPath = null; // music download failed → degrade to captions-only
      }
    }

    let headFile: string | null = null;
    let ctaFile: string | null = null;
    if (wantCaptions) {
      if (headline) { headFile = join(dir, 'head.txt'); await writeFile(headFile, headline); }
      if (cta) { ctaFile = join(dir, 'cta.txt'); await writeFile(ctaFile, cta); }
    }

    const outPath = join(dir, 'out.mp4');
    const durationSec = opts.durationSec ?? DEFAULT_DURATION;

    // Priority order: full → music-only → captions-only. First success wins.
    const attempts: Array<{ music: boolean; caps: boolean; label: string }> = [];
    if (musicPath && (headFile || ctaFile)) attempts.push({ music: true, caps: true, label: 'music+captions' });
    if (musicPath) attempts.push({ music: true, caps: false, label: 'music-only' });
    if (headFile || ctaFile) attempts.push({ music: false, caps: true, label: 'captions-only' });

    let produced: { label: string; music: boolean; caps: boolean } | null = null;
    let lastErr = '';
    for (const a of attempts) {
      const args = ffmpegArgs({
        videoPath,
        musicPath: a.music ? musicPath : null,
        headFile: a.caps ? headFile : null,
        ctaFile: a.caps ? ctaFile : null,
        durationSec,
        outPath,
      });
      try {
        await execFileP(ffmpegPath, args, { timeout: 90_000 });
        produced = { label: a.label, music: a.music, caps: a.caps };
        break;
      } catch (e: any) {
        lastErr = String(e?.stderr ?? e?.message ?? e).slice(-300);
      }
    }
    if (!produced) return skip(`ffmpeg failed: ${lastErr}`);

    const url = await uploadToStorage(await readFile(outPath), `processed/${opts.campaignId}.mp4`);
    return {
      ok: true,
      url,
      skipped: false,
      hadMusic: produced.music,
      hadCaptions: produced.caps,
      note: produced.label,
    };
  } catch (e: any) {
    return skip(`finishVideo error: ${e?.message ?? e}`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
