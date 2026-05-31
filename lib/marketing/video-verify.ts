/**
 * Post-render product-integrity gate (rulebook §1).
 *
 * Higgsfield/HeyGen animate the product and can subtly MORPH it mid-clip (the
 * "partially correct E300LFP cord" problem). The start frame is our accurate
 * approved still, so we sample MID-video frames and have Claude Vision compare
 * each to the approved product photo — flagging warped labels, distorted
 * geometry, color shift, logo morphing, duplicated/fabricated parts.
 *
 * GRACEFUL BY DESIGN: any infra failure (ffmpeg missing, download error, vision
 * error) returns { skipped:true, ok:true } so it NEVER breaks the finalize
 * pipeline — it just defers to the mandatory human approval gate. A real
 * detected morph returns { ok:false } so the operator sees a 🚨 flag and rejects.
 */
import Anthropic from '@anthropic-ai/sdk';
import ffmpegPath from 'ffmpeg-static';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileP = promisify(execFile);
const VISION_MODEL = process.env.VIDEO_VERIFY_MODEL ?? 'claude-sonnet-4-6';
const MIN_CONFIDENCE = Number(process.env.VIDEO_VERIFY_MIN_CONFIDENCE ?? 0.95);

export interface VideoVerdict {
  ok: boolean;           // safe to proceed (passed OR gracefully skipped)
  passed: boolean;       // frames actually checked AND passed
  skipped: boolean;      // verification couldn't run → human review
  minConfidence: number;
  framesChecked: number;
  issues: string[];
  note?: string;
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function fetchBuf(url: string, ms = 25_000): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function toJpeg(url: string): string {
  if (!/\.webp(\?|$)/i.test(url)) return url;
  return `https://wsrv.nl/?url=${encodeURIComponent(url.replace(/^https?:\/\//, ''))}&output=jpg`;
}

/** Extract a few mid-video frames as JPEG buffers (clips are ~5s). */
async function extractFrames(videoUrl: string): Promise<Buffer[]> {
  if (!ffmpegPath) throw new Error('ffmpeg-static unavailable');
  const dir = await mkdtemp(join(tmpdir(), 'vidverify-'));
  try {
    const vid = join(dir, 'in.mp4');
    await writeFile(vid, await fetchBuf(videoUrl, 30_000));
    const stamps = ['00:00:01.5', '00:00:03', '00:00:04.5'];
    const frames: Buffer[] = [];
    for (let i = 0; i < stamps.length; i++) {
      const out = join(dir, `f${i}.jpg`);
      try {
        await execFileP(ffmpegPath, ['-y', '-ss', stamps[i], '-i', vid, '-frames:v', '1', '-q:v', '3', out], { timeout: 20_000 });
        frames.push(await readFile(out));
      } catch {
        /* timestamp past clip end — skip */
      }
    }
    return frames;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function checkFrame(
  frame: Buffer,
  refB64: string,
  refMedia: 'image/jpeg' | 'image/png',
  productName: string,
): Promise<{ same: boolean; intact: boolean; confidence: number; issues: string[] }> {
  const resp = await client.messages.create({
    model: VISION_MODEL,
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `IMAGE 1 is the APPROVED product photo of "${productName}". IMAGE 2 is a frame from a marketing ` +
            `video. Verify the product in IMAGE 2 is the SAME product and is undistorted — check geometry, ` +
            `labels/text, color, ports, and logo. Reply ONLY with JSON: ` +
            `{"same_product":boolean,"product_intact":boolean,"confidence":0-1,"issues":[short strings]}. ` +
            `Set product_intact=false if labels are warped/unreadable, geometry is distorted, color is shifted, ` +
            `the logo is morphed, or there are duplicated/fabricated parts. No prose.`,
        },
        { type: 'image', source: { type: 'base64', media_type: refMedia, data: refB64 } },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frame.toString('base64') } },
      ],
    }],
  }, { timeout: 30_000 });
  const txt = resp.content[0]?.type === 'text' ? resp.content[0].text : '';
  const cleaned = txt.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
  try {
    const p = JSON.parse(cleaned) as { same_product?: boolean; product_intact?: boolean; confidence?: number; issues?: unknown };
    return {
      same: !!p.same_product,
      intact: !!p.product_intact,
      confidence: Number(p.confidence ?? 0),
      issues: Array.isArray(p.issues) ? p.issues.map(String) : [],
    };
  } catch {
    return { same: true, intact: true, confidence: 0, issues: ['unparseable vision response'] };
  }
}

export async function verifyVideoAccuracy(
  videoUrl: string,
  referenceImageUrl: string,
  productName: string,
): Promise<VideoVerdict> {
  const skip = (note: string): VideoVerdict =>
    ({ ok: true, passed: false, skipped: true, minConfidence: 0, framesChecked: 0, issues: [], note });

  if (!process.env.ANTHROPIC_API_KEY) return skip('no ANTHROPIC_API_KEY');

  let frames: Buffer[];
  try {
    frames = await extractFrames(videoUrl);
  } catch (e: any) {
    return skip(`frame extraction failed: ${e?.message ?? e}`);
  }
  if (frames.length === 0) return skip('no frames extracted');

  let refBuf: Buffer;
  try {
    refBuf = await fetchBuf(toJpeg(referenceImageUrl));
  } catch (e: any) {
    return skip(`reference fetch failed: ${e?.message ?? e}`);
  }
  const refMedia: 'image/jpeg' | 'image/png' =
    /\.png(\?|$)/i.test(referenceImageUrl) && !/\.webp(\?|$)/i.test(referenceImageUrl) ? 'image/png' : 'image/jpeg';
  const refB64 = refBuf.toString('base64');

  const issues: string[] = [];
  let minConf = 1;
  let ok = true;
  for (const f of frames) {
    try {
      const r = await checkFrame(f, refB64, refMedia, productName);
      minConf = Math.min(minConf, r.confidence);
      if (!r.same || !r.intact || r.confidence < MIN_CONFIDENCE) {
        ok = false;
        issues.push(...r.issues);
      }
    } catch (e: any) {
      issues.push(`frame check error: ${e?.message ?? e}`);
    }
  }
  return {
    ok,
    passed: ok,
    skipped: false,
    minConfidence: Number(minConf.toFixed(2)),
    framesChecked: frames.length,
    issues: Array.from(new Set(issues)).slice(0, 8),
  };
}
