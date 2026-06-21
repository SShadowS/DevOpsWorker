import { describe, test, expect, beforeAll } from 'bun:test';
import { companionRegistry, getCompanions, bcCompanionBranchForPlatform, registerCompanions } from '../../src/config/companions.ts';

// The public core ships only the public BC companion; the proprietary companions
// arrive from the private overlay at startup. Register neutral fixtures (same
// names, dummy URLs) so these tests exercise the resolution LOGIC.
beforeAll(() => {
  registerCompanions({
    'Core':            { url: 'https://example.com/core', defaultBranch: 'master', readOnly: true },
    'DeliveryNetwork': { url: 'https://example.com/delivery-network', defaultBranch: 'master', readOnly: true },
    'DocumentCapture': { url: 'https://example.com/document-capture', defaultBranch: 'master', readOnly: true },
    'DocumentOutput':  { url: 'https://example.com/document-output', defaultBranch: 'master', readOnly: true },
    'SystemApp':       { url: 'https://example.com/system-app', defaultBranch: 'master', readOnly: true },
    'ConnectorApp':    { url: 'https://example.com/connector-app', defaultBranch: 'master', readOnly: true },
  });
});

describe('companionRegistry', () => {
  test('all entries have required fields', () => {
    for (const [name, def] of Object.entries(companionRegistry)) {
      expect(def.url).toBeTruthy();
      expect(def.defaultBranch).toBeTruthy();
      expect(typeof def.url).toBe('string');
      expect(typeof def.defaultBranch).toBe('string');
    }
  });

  test('BC is read-only', () => {
    expect(companionRegistry['BC']?.readOnly).toBe(true);
  });

  test('all Azure DevOps URLs use HTTPS format', () => {
    for (const [name, def] of Object.entries(companionRegistry)) {
      if (name === 'BC') continue;
      expect(def.url).toMatch(/^https:\/\//);
    }
  });
});

describe('getCompanions', () => {
  test('resolves companions with default branches', () => {
    const result = getCompanions('DocumentOutput', {
      'BC': {},
      'Core': {},
    });
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe('BC');
    expect(result[0]!.branch).toBe(companionRegistry['BC']!.defaultBranch);
    expect(result[1]!.name).toBe('Core');
    expect(result[1]!.branch).toBe('master');
  });

  test('applies branch overrides', () => {
    const result = getCompanions('DocumentOutput', {
      'BC': { branch: 'w1-27' },
    });
    expect(result[0]!.branch).toBe('w1-27');
  });

  test('skips self', () => {
    const result = getCompanions('DocumentOutput', {
      'BC': {},
      'DocumentOutput': {},
      'Core': {},
    });
    expect(result).toHaveLength(2);
    expect(result.find(c => c.name === 'DocumentOutput')).toBeUndefined();
  });

  test('applies readOnly override', () => {
    const result = getCompanions('DocumentCapture', {
      'Core': { readOnly: false },
    });
    expect(result[0]!.readOnly).toBe(false);
  });

  test('defaults readOnly from registry', () => {
    const result = getCompanions('DocumentOutput', {
      'BC': {},
    });
    expect(result[0]!.readOnly).toBe(true);
  });

  test('throws for unknown companion', () => {
    expect(() => getCompanions('X', { 'NonExistent': {} })).toThrow('Unknown companion');
  });
});

describe('bcCompanionBranchForPlatform', () => {
  test('derives branch from full version string', () => {
    expect(bcCompanionBranchForPlatform('28.0.0.0')).toBe('w1-28');
  });

  test('derives branch from minor.patch version', () => {
    expect(bcCompanionBranchForPlatform('27.2.0.0')).toBe('w1-27');
  });

  test('derives branch from short version', () => {
    expect(bcCompanionBranchForPlatform('29.0')).toBe('w1-29');
  });

  test('throws on non-numeric input', () => {
    expect(() => bcCompanionBranchForPlatform('invalid')).toThrow(
      /platform 'invalid' does not start with a major version/,
    );
  });

  test('throws on empty string', () => {
    expect(() => bcCompanionBranchForPlatform('')).toThrow(
      /platform '' does not start with a major version/,
    );
  });
});

describe('getCompanions with bcPlatform option', () => {
  test('derives BC branch from platform when no override is set', () => {
    const result = getCompanions(
      'DocumentOutput',
      { 'BC': {} },
      { bcPlatform: '28.0.0.0' },
    );
    expect(result[0]!.name).toBe('BC');
    expect(result[0]!.branch).toBe('w1-28');
  });

  test('explicit BC branch override wins over derived platform', () => {
    const result = getCompanions(
      'DocumentOutput',
      { 'BC': { branch: 'w1-27' } },
      { bcPlatform: '28.0.0.0' },
    );
    expect(result[0]!.branch).toBe('w1-27');
  });

  test('falls back to registry default when no override and no bcPlatform', () => {
    const result = getCompanions(
      'DocumentOutput',
      { 'BC': {} },
    );
    expect(result[0]!.branch).toBe(companionRegistry['BC']!.defaultBranch);
  });

  test('non-BC companions ignore bcPlatform', () => {
    const result = getCompanions(
      'DocumentOutput',
      { 'Core': {}, 'DeliveryNetwork': {} },
      { bcPlatform: '28.0.0.0' },
    );
    expect(result.find(c => c.name === 'Core')!.branch).toBe('master');
    expect(result.find(c => c.name === 'DeliveryNetwork')!.branch).toBe('master');
  });

  test('malformed bcPlatform throws when BC has no override', () => {
    expect(() =>
      getCompanions('DocumentOutput', { 'BC': {} }, { bcPlatform: 'bogus' }),
    ).toThrow(/does not start with a major version/);
  });

  test('malformed bcPlatform is ignored when BC has explicit override', () => {
    const result = getCompanions(
      'DocumentOutput',
      { 'BC': { branch: 'w1-27' } },
      { bcPlatform: 'bogus' },
    );
    expect(result[0]!.branch).toBe('w1-27');
  });
});
