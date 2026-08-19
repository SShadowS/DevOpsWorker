import { describe, test, expect, afterEach, beforeEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  extractInlineImages,
  downloadWorkItemImages,
  rewriteImageSources,
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
} from '../../../src/sdk/ado/attachments.ts';
import type { PipelineConfig, WorkItem } from '../../../src/types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

const ORG = 'https://dev.azure.com/test-org';
const PROJ = '00000000-1111-2222-3333-444444444444';

/** Build an attachment URL the way Azure DevOps writes it into description HTML. */
function attachmentUrl(id: string, fileName = 'image.png'): string {
  return `${ORG}/${PROJ}/_apis/wit/attachments/${id}?fileName=${fileName}`;
}

const ID_A = '74008e0b-31eb-4b98-9602-e930193596b5';
const ID_B = '1be4af1b-8479-4d56-bcf3-3aec47843aa8';

/**
 * The real description HTML of work item 73321, trimmed to the parts that
 * matter. Kept verbatim rather than idealised — the spacing, the unquoted
 * `alt=Image`, and the `<br>` after each tag are what the parser actually meets.
 */
const REAL_HTML =
  `<div style="box-sizing:border-box;">We want a new event.</div>` +
  `<div style="box-sizing:border-box;"><img src="${attachmentUrl(ID_A)}" alt=Image><br> </div>` +
  `<div style="box-sizing:border-box;"><br> </div>` +
  `<div style="box-sizing:border-box;"><img src="${attachmentUrl(ID_B)}" alt=Image><br> </div>`;

function makeConfig(): PipelineConfig {
  return {
    azureDevOps: {
      organization: 'test-org',
      orgUrl: ORG,
      project: 'Test Project',
      repositoryId: 'repo-id',
      repositoryName: 'TestRepo',
      ciPipelineId: 1,
      cdPipelineId: 2,
      areaPath: 'Proj\\Area',
      iterationPath: 'Proj\\Iter',
      pat: 'test-pat',
    },
    paths: { sessionRoot: '/tmp/session', targetRepo: '/tmp/session/doc', stateDir: '/tmp/session/state' },
    checkpoints: {
      planApproval: { tag: 'plan-approved', rerunCommand: '/rerun-plan', timeoutHours: 48 },
      prPublished: { fixCommand: '/fix', timeoutHours: 48 },
      pollIntervalMinutes: 5,
    },
    revisionLoops: { maxAttempts: 3 },
    models: { default: 'claude-sonnet' },
    costs: {},
    repoKey: 'DocumentOutput',
    layout: { appRoot: 'Cloud', source: 'Cloud/AL', testAppRoot: 'Test', test: 'Test/AL' },
  } as unknown as PipelineConfig;
}

function makeWorkItem(description?: string): WorkItem {
  return {
    id: 73321,
    title: 'new event OnBeforeGetDocumentAttachment',
    type: 'User Story',
    state: 'Active',
    description,
    areaPath: 'Proj\\Area',
    iterationPath: 'Proj\\Iter',
    fields: {},
  };
}

/** The eight-byte PNG signature, which is what identifies these files. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A real (if tiny) PNG: the signature followed by `payload`. */
function pngBytes(payload = 'body'): Uint8Array<ArrayBuffer> {
  return new Uint8Array([...PNG_SIGNATURE, ...Buffer.from(payload)]);
}

/** Respond to every request with the same image body. */
function mockImageFetch(body: Uint8Array<ArrayBuffer> | string = pngBytes(), contentType = 'image/png') {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(new Blob([body]), { status: 200, headers: { 'content-type': contentType } })),
  ) as unknown as typeof fetch;
}

let dest: string;

beforeEach(() => {
  dest = mkdtempSync(join(tmpdir(), 'wi-images-'));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(dest, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// extractInlineImages
// ---------------------------------------------------------------------------

describe('extractInlineImages', () => {
  test('finds both images in real work item description HTML', () => {
    const refs = extractInlineImages(REAL_HTML);

    expect(refs).toHaveLength(2);
    expect(refs[0]!.id).toBe(ID_A);
    expect(refs[1]!.id).toBe(ID_B);
    expect(refs[0]!.fileName).toBe('image.png');
  });

  test('returns nothing for undefined, empty, or image-free HTML', () => {
    expect(extractInlineImages(undefined)).toEqual([]);
    expect(extractInlineImages('')).toEqual([]);
    expect(extractInlineImages('<div>plain text, no pictures</div>')).toEqual([]);
  });

  test('ignores images hosted outside Azure DevOps attachments', () => {
    // An avatar or a pasted external link is not a work item attachment, and
    // fetching it with the PAT would send our credential to a third party.
    const html = `<img src="https://example.com/cat.png"><img src="${attachmentUrl(ID_A)}">`;

    const refs = extractInlineImages(html);

    expect(refs).toHaveLength(1);
    expect(refs[0]!.id).toBe(ID_A);
  });

  test('decodes &amp; so the query string survives', () => {
    // Azure DevOps HTML-escapes the ampersand between query parameters. Left
    // encoded, the request carries a parameter literally named `amp;fileName`.
    const html = `<img src="${ORG}/${PROJ}/_apis/wit/attachments/${ID_A}?fileName=shot.png&amp;download=false">`;

    const refs = extractInlineImages(html);

    expect(refs[0]!.url).toContain('&download=false');
    expect(refs[0]!.url).not.toContain('&amp;');
    expect(refs[0]!.fileName).toBe('shot.png');
  });

  test('accepts single-quoted src attributes', () => {
    const refs = extractInlineImages(`<img src='${attachmentUrl(ID_A)}'>`);

    expect(refs).toHaveLength(1);
    expect(refs[0]!.id).toBe(ID_A);
  });

  test('collapses the same attachment referenced twice', () => {
    // Pasting one screenshot in two places must not download it twice, and must
    // not produce two files for the agent to compare.
    const html = `<img src="${attachmentUrl(ID_A)}"><p>and again</p><img src="${attachmentUrl(ID_A)}">`;

    expect(extractInlineImages(html)).toHaveLength(1);
  });

  test('falls back to the attachment id when the URL names no file', () => {
    const refs = extractInlineImages(`<img src="${ORG}/${PROJ}/_apis/wit/attachments/${ID_A}">`);

    expect(refs).toHaveLength(1);
    expect(refs[0]!.fileName).toBe(ID_A);
  });

  test('decodes percent-escapes in the file name', () => {
    const refs = extractInlineImages(`<img src="${attachmentUrl(ID_A, 'my%20shot.png')}">`);

    expect(refs[0]!.fileName).toBe('my shot.png');
  });
});

// ---------------------------------------------------------------------------
// downloadWorkItemImages
// ---------------------------------------------------------------------------

describe('downloadWorkItemImages', () => {
  test('writes each image to disk and returns its path', async () => {
    mockImageFetch();

    const images = await downloadWorkItemImages(makeWorkItem(REAL_HTML), dest, makeConfig());

    expect(images).toHaveLength(2);
    for (const img of images) {
      expect(existsSync(img.path)).toBe(true);
      expect([...readFileSync(img.path).subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    }
  });

  test('accepts an image served as application/octet-stream', async () => {
    // Measured against the live API: the same attachment comes back as
    // `image/png` when the URL carries `fileName`, and as
    // `application/octet-stream` when it does not. The bytes are identical, so
    // the header cannot be what decides.
    mockImageFetch(pngBytes(), 'application/octet-stream');

    const images = await downloadWorkItemImages(makeWorkItem(REAL_HTML), dest, makeConfig());

    expect(images).toHaveLength(2);
  });

  test('saves under the extension the bytes say, not the one the name claims', async () => {
    mockImageFetch(pngBytes());
    const html = `<img src="${attachmentUrl(ID_A, 'screenshot.jpg')}">`;

    const images = await downloadWorkItemImages(makeWorkItem(html), dest, makeConfig());

    expect(images[0]!.path.endsWith('.png')).toBe(true);
  });

  test('names files so two `image.png` attachments do not overwrite each other', async () => {
    mockImageFetch();

    const images = await downloadWorkItemImages(makeWorkItem(REAL_HTML), dest, makeConfig());

    expect(images[0]!.path).not.toBe(images[1]!.path);
    expect(images[0]!.path).toContain('73321');
  });

  test('sends the PAT as basic auth', async () => {
    mockImageFetch();

    await downloadWorkItemImages(makeWorkItem(`<img src="${attachmentUrl(ID_A)}">`), dest, makeConfig());

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Basic ${Buffer.from(':test-pat').toString('base64')}`);
  });

  test('does not call the network when there are no images', async () => {
    mockImageFetch();

    const images = await downloadWorkItemImages(makeWorkItem('<div>no pictures</div>'), dest, makeConfig());

    expect(images).toEqual([]);
    expect(globalThis.fetch as unknown as ReturnType<typeof mock>).toHaveBeenCalledTimes(0);
  });

  test('keeps the images it could fetch when one download fails', async () => {
    // A single dead attachment must not cost the agent the other screenshot,
    // and must not stop the pipeline — this runs before the analyzer.
    let call = 0;
    globalThis.fetch = mock(() => {
      call += 1;
      return call === 1
        ? Promise.resolve(new Response('nope', { status: 404, statusText: 'Not Found' }))
        : Promise.resolve(
            new Response(new Blob([pngBytes()]), { status: 200, headers: { 'content-type': 'image/png' } }),
          );
    }) as unknown as typeof fetch;

    const images = await downloadWorkItemImages(makeWorkItem(REAL_HTML), dest, makeConfig());

    expect(images).toHaveLength(1);
    expect(images[0]!.sourceUrl).toContain(ID_B);
  });

  test('survives a network error without throwing', async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error('socket hang up'))) as unknown as typeof fetch;

    const images = await downloadWorkItemImages(makeWorkItem(REAL_HTML), dest, makeConfig());

    expect(images).toEqual([]);
  });

  test('discards a response that is not an image', async () => {
    // The attachment endpoint answers an expired or wrong id with an HTML error
    // page and a 200. Written to disk as `.png`, that becomes a file the Read
    // tool rejects — and the agent reads the rejection as its own mistake.
    mockImageFetch('<html>Sign in</html>', 'text/html');

    const images = await downloadWorkItemImages(makeWorkItem(REAL_HTML), dest, makeConfig());

    expect(images).toEqual([]);
  });

  test('discards an image larger than the byte cap', async () => {
    mockImageFetch(pngBytes('x'.repeat(MAX_IMAGE_BYTES)));

    const images = await downloadWorkItemImages(makeWorkItem(REAL_HTML), dest, makeConfig());

    expect(images).toEqual([]);
  });

  test('stops at the image cap', async () => {
    mockImageFetch();
    const many = Array.from(
      { length: MAX_IMAGES + 3 },
      (_, i) => `<img src="${attachmentUrl(`00000000-0000-0000-0000-${String(i).padStart(12, '0')}`)}">`,
    ).join('');

    const images = await downloadWorkItemImages(makeWorkItem(many), dest, makeConfig());

    expect(images).toHaveLength(MAX_IMAGES);
  });

  test('reads images out of the acceptance criteria too', async () => {
    mockImageFetch();
    const wi = makeWorkItem('<div>no pictures here</div>');
    wi.acceptanceCriteria = `<img src="${attachmentUrl(ID_A)}">`;

    const images = await downloadWorkItemImages(wi, dest, makeConfig());

    expect(images).toHaveLength(1);
  });

  test('creates the destination directory if it is missing', async () => {
    mockImageFetch();
    const nested = join(dest, 'deep', 'nested');

    const images = await downloadWorkItemImages(makeWorkItem(REAL_HTML), nested, makeConfig());

    expect(images).toHaveLength(2);
    expect(existsSync(nested)).toBe(true);
  });

  test('strips path separators out of the attachment file name', async () => {
    // The file name comes from a URL, so it is attacker-influenced input. Left
    // alone, `../../x.png` writes outside the destination directory.
    mockImageFetch();
    const html = `<img src="${attachmentUrl(ID_A, '..%2F..%2Fescape.png')}">`;

    const images = await downloadWorkItemImages(makeWorkItem(html), dest, makeConfig());

    expect(images).toHaveLength(1);
    expect(images[0]!.path.startsWith(dest)).toBe(true);
    expect(images[0]!.path).not.toContain('..');
  });
});

// ---------------------------------------------------------------------------
// rewriteImageSources
// ---------------------------------------------------------------------------

describe('rewriteImageSources', () => {
  test('replaces the attachment URL with the local file path', async () => {
    mockImageFetch();
    const images = await downloadWorkItemImages(makeWorkItem(REAL_HTML), dest, makeConfig());

    const rewritten = rewriteImageSources(REAL_HTML, images);

    expect(rewritten).toContain(images[0]!.path);
    expect(rewritten).toContain(images[1]!.path);
    expect(rewritten).not.toContain('_apis/wit/attachments');
  });

  test('keeps the surrounding text so an image stays where it was written', () => {
    // Position carries meaning: "the signature below" is only true if the marker
    // lands where the picture did.
    const images = [{ path: '/s/.wi-images/a.png', fileName: 'image.png', sourceUrl: attachmentUrl(ID_A) }];
    const html = `<p>Use this signature:</p><img src="${attachmentUrl(ID_A)}"><p>Then wire it up.</p>`;

    const rewritten = rewriteImageSources(html, images)!;

    expect(rewritten.indexOf('Use this signature')).toBeLessThan(rewritten.indexOf('/s/.wi-images/a.png'));
    expect(rewritten.indexOf('/s/.wi-images/a.png')).toBeLessThan(rewritten.indexOf('Then wire it up'));
  });

  test('leaves an image alone when its download failed', () => {
    // No local file exists, so pointing at one would send the agent to a path
    // that is not there. The original URL at least says a picture is missing.
    const html = `<img src="${attachmentUrl(ID_A)}">`;

    expect(rewriteImageSources(html, [])).toBe(html);
  });

  test('handles undefined HTML', () => {
    expect(rewriteImageSources(undefined, [])).toBeUndefined();
  });
});
