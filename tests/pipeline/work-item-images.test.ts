import { describe, test, expect } from 'bun:test';
import { buildWorkItemImagesSection } from '../../src/pipeline/work-item-images.ts';
import type { WorkItemImage } from '../../src/types/pipeline.types.ts';

function image(n: number): WorkItemImage {
  return {
    path: `/session/.work-item-images/wi-73321-${n}-image.png`,
    fileName: 'image.png',
    sourceUrl: `https://dev.azure.com/org/proj/_apis/wit/attachments/id-${n}?fileName=image.png`,
  };
}

describe('buildWorkItemImagesSection', () => {
  test('says nothing when the work item has no images', () => {
    expect(buildWorkItemImagesSection([])).toEqual([]);
    expect(buildWorkItemImagesSection(undefined)).toEqual([]);
  });

  test('lists every image path so the agent can open each one', () => {
    const section = buildWorkItemImagesSection([image(1), image(2)]).join('\n');

    expect(section).toContain('/session/.work-item-images/wi-73321-1-image.png');
    expect(section).toContain('/session/.work-item-images/wi-73321-2-image.png');
  });

  test('names the Read tool, which is how an image is actually opened', () => {
    const section = buildWorkItemImagesSection([image(1)]).join('\n');

    expect(section).toContain('Read');
  });

  test('counts the images correctly for one and for many', () => {
    expect(buildWorkItemImagesSection([image(1)]).join('\n')).toContain('1 image');
    expect(buildWorkItemImagesSection([image(1), image(2)]).join('\n')).toContain('2 images');
  });

  test('is written as an instruction to look, not as a prohibition', () => {
    // Negative framing is measured on this project to suppress far more than it
    // targets, so this section tells the agent what to do and never what not to.
    const section = buildWorkItemImagesSection([image(1)]).join('\n').toLowerCase();

    expect(section).not.toContain('never');
    expect(section).not.toContain("don't");
    expect(section).not.toContain('do not');
  });
});
