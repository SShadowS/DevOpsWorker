import { describe, test, expect } from 'bun:test';
import type { IReflectionStore } from '../../src/pipeline/reflection-store.interface.ts';
import type { ReflectionProposal } from '../../src/db/reflection-proposal-mapper.ts';

type SaveInput = Parameters<IReflectionStore['save']>[0];

export class FakeReflectionStore implements IReflectionStore {
  rows: ReflectionProposal[] = [];
  private nextId = 1;
  async save(p: SaveInput): Promise<number> {
    for (const r of this.rows) {
      if (r.cycleDate === p.cycleDate && r.status === 'pending') r.status = 'superseded';
    }
    const row: ReflectionProposal = {
      ...p, id: this.nextId++, status: 'pending',
      decidedBy: null, decidedAt: null, appliedAt: null, appliedCommits: null,
      createdAt: new Date(0).toISOString(),
    };
    this.rows.push(row);
    return row.id;
  }
  async listRecent(limit = 20) { return [...this.rows].reverse().slice(0, limit); }
  async findById(id: number) { return this.rows.find(r => r.id === id) ?? null; }
  async findByCycle(cycleDate: string) {
    return [...this.rows].reverse().find(r => r.cycleDate === cycleDate && r.status !== 'superseded') ?? null;
  }
  async decide(id: number, decision: 'approved' | 'rejected', decidedBy: string) {
    const r = this.rows.find(x => x.id === id);
    if (!r || r.status !== 'pending') return false;
    r.status = decision; r.decidedBy = decidedBy; r.decidedAt = new Date(0).toISOString();
    return true;
  }
  async markApplied(id: number, commits: { core?: string; overlay?: string }) {
    const r = this.rows.find(x => x.id === id);
    if (!r || r.status !== 'approved') return false;
    r.status = 'applied'; r.appliedCommits = commits; r.appliedAt = new Date(0).toISOString();
    return true;
  }
}

const minimal: SaveInput = {
  cycleDate: '2026-08-15', windowDays: 35, coverage: null,
  adjudications: [], clusters: [], proposedChanges: [],
  watchLedger: null, classifierNotes: null, expectedEffects: null,
  logEntryDraft: null, costUsd: null, sessionId: null, error: null, imageSha: null,
};

describe('reflection store contract (fake)', () => {
  test('save supersedes an older pending row for the same cycle', async () => {
    const s = new FakeReflectionStore();
    const a = await s.save(minimal);
    const b = await s.save(minimal);
    expect((await s.findById(a))!.status).toBe('superseded');
    expect((await s.findById(b))!.status).toBe('pending');
    expect((await s.findByCycle('2026-08-15'))!.id).toBe(b);
  });
  test('decide only moves pending rows', async () => {
    const s = new FakeReflectionStore();
    const id = await s.save(minimal);
    expect(await s.decide(id, 'approved', 'torben')).toBe(true);
    expect(await s.decide(id, 'rejected', 'torben')).toBe(false);
  });
  test('markApplied only moves approved rows', async () => {
    const s = new FakeReflectionStore();
    const id = await s.save(minimal);
    expect(await s.markApplied(id, { core: 'abc' })).toBe(false);
    await s.decide(id, 'approved', 'torben');
    expect(await s.markApplied(id, { core: 'abc' })).toBe(true);
    expect((await s.findById(id))!.status).toBe('applied');
  });
});
