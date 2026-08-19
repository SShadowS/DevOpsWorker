import type { WorkItemImage } from '../types/pipeline.types.ts';

/**
 * Prompt section pointing an agent at the screenshots on its work item.
 *
 * People put load-bearing detail in pictures — a proposed signature, an error
 * dialog, a page layout — and then write a sentence that only makes sense
 * beside the picture. Work item 73321 asked for a new event and put the exact
 * signature in two screenshots; the analyzer read the words, saw an attachment
 * URL it could not open, and stopped to ask a human what the pictures said.
 *
 * The files are already on disk by the time any agent runs (see
 * `downloadWorkItemImages`), so all this section has to do is say where they
 * are and that `Read` opens them.
 *
 * Returns an empty array when there is nothing to look at, so callers can
 * spread it unconditionally.
 */
export function buildWorkItemImagesSection(images: readonly WorkItemImage[] | undefined): string[] {
  if (!images || images.length === 0) return [];

  const count = images.length === 1 ? '1 image' : `${images.length} images`;

  return [
    ``,
    `## Screenshots on the Work Item`,
    `This work item includes ${count}, already downloaded. Open each one with \`Read\` — it displays the picture:`,
    ...images.map(img => `- \`${img.path}\``),
    ``,
    `Look at them before judging whether the work item explains itself. A screenshot often carries`,
    `the signature, the error text, or the screen layout that the written description leaves out, and`,
    `the description points at each picture where it belongs in the text.`,
  ];
}
