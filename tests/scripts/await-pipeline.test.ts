import { describe, test, expect } from 'bun:test';
import {
  resolveOrgUrl,
  resolveProject,
  assertOrgConfigured,
  buildResumeHint,
  SCRIPT_PATH,
  PLACEHOLDER_ORG,
} from '../../scripts/await-pipeline.ts';

// ---------------------------------------------------------------------------
// The regression these exist for.
//
// This script read `ADO_ORG_URL` / `ADO_PROJECT` — names set nowhere in this repo,
// the overlay, `.env` or the Dockerfile. Every invocation therefore fell through to
// the placeholder org and got a route-level 404 from ADO, which is indistinguishable
// from "that build does not exist". The ci-waiter reported FAILED, the coder believed
// CI had failed, and the coding loop burned rounds on a build that was fine.
//
// Measured before the fix: 11 work items, 83 occurrences, 2026-03-20 to 2026-08-02.
// Four and a half months in which no containerized coder run had a working CI wait,
// and nothing ever failed loudly enough to be noticed.
//
// These are pure-function tests over an injected env — no process.env mutation, no
// network, no DB.
// ---------------------------------------------------------------------------

describe('resolveOrgUrl', () => {
  test('prefers AZURE_DEVOPS_ORG_URL — the name the deployment actually sets', () => {
    // THE regression. If this ever reads only the ADO_* alias again, the script
    // silently targets a placeholder org and every 404 lies about why.
    expect(resolveOrgUrl({ AZURE_DEVOPS_ORG_URL: 'https://dev.azure.com/real' })).toBe(
      'https://dev.azure.com/real',
    );
  });

  test('AZURE_DEVOPS_ORG_URL wins when both names are set', () => {
    const env = { AZURE_DEVOPS_ORG_URL: 'https://dev.azure.com/real', ADO_ORG_URL: 'https://dev.azure.com/legacy' };
    expect(resolveOrgUrl(env)).toBe('https://dev.azure.com/real');
  });

  test('falls back to the ADO_ORG_URL alias so an older environment still works', () => {
    expect(resolveOrgUrl({ ADO_ORG_URL: 'https://dev.azure.com/legacy' })).toBe(
      'https://dev.azure.com/legacy',
    );
  });

  test('returns the placeholder when neither is set — the state assertOrgConfigured refuses', () => {
    expect(resolveOrgUrl({})).toBe(PLACEHOLDER_ORG);
  });

  test('treats an empty string as unset, not as a configured value', () => {
    // `??` would accept '' and target `https:///_apis/...`. A blank var is how a
    // half-filled .env presents itself, so it must take the same path as absent.
    expect(resolveOrgUrl({ AZURE_DEVOPS_ORG_URL: '', ADO_ORG_URL: '' })).toBe(PLACEHOLDER_ORG);
  });
});

describe('resolveProject', () => {
  test('prefers AZURE_DEVOPS_PROJECT, falls back to the alias, then the placeholder', () => {
    expect(resolveProject({ AZURE_DEVOPS_PROJECT: 'Real' })).toBe('Real');
    expect(resolveProject({ ADO_PROJECT: 'Legacy' })).toBe('Legacy');
    expect(resolveProject({})).toBe('Your Project');
  });
});

describe('assertOrgConfigured', () => {
  test('refuses the placeholder BEFORE any request is made', () => {
    // The whole point: fail with a cause, rather than 404 and blame the run id.
    expect(() => assertOrgConfigured(PLACEHOLDER_ORG)).toThrow(/not configured/i);
  });

  test('the message names the env var to set and says a 404 here is not a missing build', () => {
    // Self-diagnosing. The original failure survived 83 occurrences precisely
    // because the error named the run and never the org it was asking.
    let message = '';
    try { assertOrgConfigured(PLACEHOLDER_ORG); } catch (e) { message = (e as Error).message; }
    expect(message).toContain('AZURE_DEVOPS_ORG_URL');
    expect(message).toMatch(/NOT a missing build/i);
  });

  test('passes a real org through', () => {
    expect(() => assertOrgConfigured('https://dev.azure.com/real')).not.toThrow();
  });
});

describe('buildResumeHint', () => {
  test('quotes an ABSOLUTE script path — the waiter re-runs this command verbatim', () => {
    // An agent's cwd is the session root, which has no `scripts/`. A relative path
    // here handed the ci-waiter a command that could not run, which it reported as
    // a configuration error while the build itself was healthy.
    const hint = buildResumeHint(726756, 100, true);
    expect(hint).toContain(`bun ${SCRIPT_PATH} --attach 726756`);
    expect(hint).not.toMatch(/bun\s+scripts\//);
  });

  test('keeps the --waiter sentinel so the guard hook still recognises the re-run', () => {
    expect(buildResumeHint(1, 100, true)).toContain('--waiter');
    expect(buildResumeHint(1, 100, false)).not.toContain('--waiter');
  });
});
