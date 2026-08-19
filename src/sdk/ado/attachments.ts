/**
 * Work item attachments — downloading the pictures a description points at.
 *
 * Azure DevOps embeds screenshots in a work item description as ordinary
 * `<img>` tags whose `src` is an attachment URL:
 *
 *   <img src="https://dev.azure.com/org/<project-guid>/_apis/wit/attachments/
 *             74008e0b-31eb-4b98-9602-e930193596b5?fileName=image.png">
 *
 * That URL reaches the agents already — the description is passed through as
 * raw HTML — and is useless to them. Fetching it needs the PAT, and the reading
 * agents have no tool that can make an authenticated request: the analyzer
 * denies `Bash` and has no web fetch. So an agent sees that a picture exists,
 * cannot look at it, and asks a human what was in it. Work item 73321 stalled
 * exactly there: two screenshots held the event signature it was asking for.
 *
 * Downloading them first turns each into a local file, which the `Read` tool
 * opens and actually looks at.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { PipelineConfig, WorkItem, WorkItemImage } from '../../types/pipeline.types.ts';

/**
 * How many images one work item may contribute.
 *
 * Every image is re-encoded into the prompt of every agent that reads it, and
 * bills as input tokens each turn it stays in context. A description with forty
 * screenshots is a cost accident, not a richer description.
 */
export const MAX_IMAGES = 10;

/** Largest single image worth spending on, in bytes. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Identify an image by its leading bytes.
 *
 * The `Content-Type` header is not reliable here, and that is measured against
 * the live API rather than assumed. The same attachment served with `fileName`
 * in the query comes back as `image/png`; served without it, the identical
 * bytes come back as `application/octet-stream`. Trusting the header therefore
 * discards real screenshots on a difference in how the URL was written.
 *
 * Sniffing also settles the opposite case for free: the attachment endpoint
 * answers an unknown or expired id with a sign-in page and status 200, which
 * has no image signature and is dropped.
 *
 * SVG is deliberately absent. It is an `image/*` type with no binary signature,
 * and the `Read` tool cannot display it as a picture — downloading one would
 * only produce a file that fails later.
 *
 * Returns the file extension to save under, or null when these bytes are not a
 * picture anything can show.
 */
function sniffImageExtension(bytes: Uint8Array): string | null {
  const startsWith = (...sig: number[]): boolean =>
    bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);

  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (startsWith(0xff, 0xd8, 0xff)) return 'jpg';
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return 'gif'; // "GIF8"
  if (startsWith(0x42, 0x4d)) return 'bmp'; // "BM"
  // WEBP is a RIFF container: "RIFF" ....  "WEBP"
  if (
    startsWith(0x52, 0x49, 0x46, 0x46) &&
    bytes.length >= 12 &&
    [0x57, 0x45, 0x42, 0x50].every((b, i) => bytes[8 + i] === b)
  ) {
    return 'webp';
  }

  return null;
}

/** An `<img>` in work item HTML that points at an Azure DevOps attachment. */
export interface InlineImageRef {
  /** Attachment GUID. */
  id: string;
  /** File name from the URL's `fileName` parameter, or the id when it names none. */
  fileName: string;
  /** Full attachment URL, HTML-decoded so it can be requested as-is. */
  url: string;
  /** The `src` value exactly as it appears in the HTML, still encoded. */
  rawUrl: string;
}

/** Matches the `src` of any `<img>` tag, single- or double-quoted. */
const IMG_SRC = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/** Pulls the attachment GUID out of an Azure DevOps attachment URL. */
const ATTACHMENT_ID = /\/_apis\/wit\/attachments\/([0-9a-fA-F-]{36})/;

/** Minimal HTML entity decoding — enough for a URL sitting in an attribute. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * Every distinct Azure DevOps attachment image referenced by `html`.
 *
 * Images hosted elsewhere are skipped: an avatar or a pasted external link is
 * not a work item attachment, and requesting one with the PAT attached would
 * hand our credential to a third party.
 *
 * The same attachment referenced twice yields one ref — pasting a screenshot in
 * two places should not produce two files for an agent to compare.
 */
export function extractInlineImages(html: string | undefined): InlineImageRef[] {
  if (!html) return [];

  const refs: InlineImageRef[] = [];
  const seen = new Set<string>();

  for (const match of html.matchAll(IMG_SRC)) {
    const rawUrl = match[1] ?? match[2];
    if (!rawUrl) continue;

    const url = decodeEntities(rawUrl);
    const id = url.match(ATTACHMENT_ID)?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);

    refs.push({ id, fileName: fileNameFromUrl(url, id), url, rawUrl });
  }

  return refs;
}

/** The `fileName` query parameter, decoded; the attachment id when absent. */
function fileNameFromUrl(url: string, id: string): string {
  const raw = url.match(/[?&]fileName=([^&]*)/i)?.[1];
  if (!raw) return id;
  try {
    return decodeURIComponent(raw) || id;
  } catch {
    // A malformed escape is not worth failing over — the id names the file fine.
    return id;
  }
}

/**
 * Make a file name safe to join onto a directory path.
 *
 * The name arrives inside a URL, so it is input we do not control: a `fileName`
 * of `../../escape.png` would otherwise write outside the destination.
 */
function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '_') || 'image';
}

/**
 * Download every image embedded in a work item into `destDir`.
 *
 * **Never throws.** This runs before the first agent, on the path every `run`
 * and `continue` takes, so a dead attachment or a flaky network must cost the
 * pictures and nothing else. Failures are warned about and skipped; the caller
 * receives whatever arrived.
 */
export async function downloadWorkItemImages(
  workItem: WorkItem,
  destDir: string,
  config: PipelineConfig,
): Promise<WorkItemImage[]> {
  const refs = [
    ...extractInlineImages(workItem.description),
    ...extractInlineImages(workItem.acceptanceCriteria),
  ];

  // Description and acceptance criteria can embed the same screenshot.
  const unique = [...new Map(refs.map(r => [r.id, r])).values()];
  if (unique.length === 0) return [];

  if (unique.length > MAX_IMAGES) {
    console.warn(
      `[attachments] work item ${workItem.id} embeds ${unique.length} images — using the first ${MAX_IMAGES}`,
    );
  }
  const wanted = unique.slice(0, MAX_IMAGES);

  try {
    mkdirSync(destDir, { recursive: true });
  } catch (err) {
    console.warn(`[attachments] cannot create ${destDir}: ${describe(err)} — continuing without images`);
    return [];
  }

  const images: WorkItemImage[] = [];
  for (const [index, ref] of wanted.entries()) {
    const image = await downloadOne(ref, index, workItem.id, destDir, config);
    if (image) images.push(image);
  }

  return images;
}

/** Fetch and write one attachment, or warn and return null. */
async function downloadOne(
  ref: InlineImageRef,
  index: number,
  workItemId: number,
  destDir: string,
  config: PipelineConfig,
): Promise<WorkItemImage | null> {
  const auth = Buffer.from(':' + config.azureDevOps.pat).toString('base64');
  const url = ref.url.includes('api-version=')
    ? ref.url
    : `${ref.url}${ref.url.includes('?') ? '&' : '?'}api-version=7.0`;

  try {
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });

    if (!res.ok) {
      console.warn(`[attachments] ${ref.id}: ${res.status} ${res.statusText} — skipped`);
      return null;
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      console.warn(
        `[attachments] ${ref.id}: ${bytes.byteLength} bytes exceeds the ${MAX_IMAGE_BYTES} cap — skipped`,
      );
      return null;
    }

    const extension = sniffImageExtension(bytes);
    if (!extension) {
      const contentType = res.headers.get('content-type') ?? 'no content type';
      console.warn(`[attachments] ${ref.id}: not a readable image (served as ${contentType}) — skipped`);
      return null;
    }

    // Attachments are very often all called `image.png`, so the work item and a
    // running index carry the uniqueness rather than the name. The extension
    // comes from the bytes, not from the name — a file called `.png` holding a
    // JPEG should still be saved as what it is.
    const base = safeFileName(ref.fileName).replace(/\.[A-Za-z0-9]+$/, '') || 'image';
    const path = join(destDir, `wi-${workItemId}-${index + 1}-${base}.${extension}`);
    writeFileSync(path, bytes);

    return { path, fileName: ref.fileName, sourceUrl: ref.url };
  } catch (err) {
    console.warn(`[attachments] ${ref.id}: ${describe(err)} — skipped`);
    return null;
  }
}

/**
 * Point every `<img>` at the local file that was downloaded for it.
 *
 * Position carries meaning in these descriptions — "the signature below" is
 * only true if the path lands where the picture did — so the tag is edited in
 * place rather than the images being listed separately. An image whose download
 * failed keeps its original URL: there is no local file to send the agent to,
 * and the URL at least says a picture is missing.
 */
export function rewriteImageSources(
  html: string | undefined,
  images: readonly WorkItemImage[],
): string | undefined {
  if (!html || images.length === 0) return html;

  const pathById = new Map<string, string>();
  for (const image of images) {
    const id = image.sourceUrl.match(ATTACHMENT_ID)?.[1];
    if (id) pathById.set(id.toLowerCase(), image.path);
  }

  return html.replace(IMG_SRC, (full, doubleQuoted?: string, singleQuoted?: string) => {
    const rawUrl = doubleQuoted ?? singleQuoted;
    if (!rawUrl) return full;
    const id = decodeEntities(rawUrl).match(ATTACHMENT_ID)?.[1];
    const path = id ? pathById.get(id.toLowerCase()) : undefined;
    return path ? full.replace(rawUrl, path) : full;
  });
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
