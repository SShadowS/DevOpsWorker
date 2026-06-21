import { describe, test, expect } from 'bun:test';
import { DocsDraftSchema, DocsWriterOutputSchema } from '../../../src/agents/docs-writer/schema.ts';

describe('DocsDraftSchema', () => {
  test('accepts a valid draft entry', () => {
    const draft = {
      filePath: 'Business functionality/Email/New feature.md',
      action: 'create' as const,
      title: 'New Email Feature',
      summary: 'Documents the new batch email feature',
    };
    expect(DocsDraftSchema.parse(draft)).toEqual(draft);
  });

  test('accepts an update with existingPageId', () => {
    const draft = {
      filePath: 'Business functionality/Email/Document queue.md',
      action: 'update' as const,
      existingPageId: 'DO-72',
      title: 'Document Queue',
      summary: 'Updated to include new filter options',
    };
    expect(DocsDraftSchema.parse(draft)).toEqual(draft);
  });

  test('rejects invalid action enum', () => {
    const draft = {
      filePath: 'test.md',
      action: 'delete',
      title: 'Test',
      summary: 'Test',
    };
    expect(() => DocsDraftSchema.parse(draft)).toThrow();
  });

  test('rejects missing filePath', () => {
    const draft = {
      action: 'create',
      title: 'Test',
      summary: 'Test',
    };
    expect(() => DocsDraftSchema.parse(draft)).toThrow();
  });
});

describe('DocsWriterOutputSchema', () => {
  test('accepts valid output with drafts', () => {
    const output = {
      drafts: [
        {
          filePath: 'Business functionality/Email/New feature.md',
          action: 'create' as const,
          title: 'New Email Feature',
          summary: 'Documents the new batch email feature',
        },
      ],
      analysisNotes: 'New UI page added for batch email settings',
      existingPagesReviewed: ['Document Queue (DO-72)', 'Email Templates (DO-58)'],
      noDocsNeeded: false,
      rationale: 'New feature adds a visible page that users need to know about',
    };
    expect(DocsWriterOutputSchema.parse(output)).toEqual(output);
  });

  test('accepts noDocsNeeded=true with empty drafts', () => {
    const output = {
      drafts: [],
      analysisNotes: 'Bug fix restores expected behavior, no visible change',
      existingPagesReviewed: ['Document Queue (DO-72)'],
      noDocsNeeded: true,
      rationale: 'Internal bug fix with no user-facing impact',
    };
    expect(DocsWriterOutputSchema.parse(output)).toEqual(output);
  });

  test('rejects missing required fields', () => {
    expect(() => DocsWriterOutputSchema.parse({
      drafts: [],
      analysisNotes: 'test',
      // missing existingPagesReviewed, noDocsNeeded, rationale
    })).toThrow();
  });

  test('rejects missing drafts array', () => {
    expect(() => DocsWriterOutputSchema.parse({
      analysisNotes: 'test',
      existingPagesReviewed: [],
      noDocsNeeded: true,
      rationale: 'test',
    })).toThrow();
  });

  test('rejects missing rationale', () => {
    expect(() => DocsWriterOutputSchema.parse({
      drafts: [],
      analysisNotes: 'test',
      existingPagesReviewed: [],
      noDocsNeeded: true,
    })).toThrow();
  });
});
