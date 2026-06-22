import { signal } from '@preact/signals';
import type { DashboardSession } from '../../types.ts';

const activeTab = signal('readiness');

type AdoCfg = DashboardSession['config'];

/** Base Azure DevOps URL for a session's org/project, or null if config is absent.
 *  Org/project come from the persisted pipeline config — never hardcode them. */
function adoBase(cfg: AdoCfg): string | null {
  if (!cfg?.organization || !cfg?.project) return null;
  return `https://dev.azure.com/${encodeURIComponent(cfg.organization)}/${encodeURIComponent(cfg.project)}`;
}

interface TabDef {
  key: string;
  label: string;
  hasData: (s: DashboardSession) => boolean;
  render: (s: DashboardSession) => any;
}

const TABS: TabDef[] = [
  { key: 'readiness', label: 'Readiness', hasData: (s) => !!s.readiness, render: (s) => <ReadinessView data={s.readiness} /> },
  { key: 'devPlan', label: 'Plan', hasData: (s) => !!s.devPlan, render: (s) => <DevPlanView data={s.devPlan} /> },
  { key: 'planReviews', label: 'Plan Reviews', hasData: (s) => (s.planReviews?.length ?? 0) > 0, render: (s) => <ReviewList reviews={s.planReviews} /> },
  { key: 'changeset', label: 'Code', hasData: (s) => !!s.changeset, render: (s) => <ChangesetView data={s.changeset} cfg={s.config} /> },
  { key: 'codeReviews', label: 'Code Reviews', hasData: (s) => (s.codeReviews?.length ?? 0) > 0, render: (s) => <ReviewList reviews={s.codeReviews} /> },
  { key: 'testCases', label: 'Tests', hasData: (s) => !!s.testCases, render: (s) => <TestCasesView data={s.testCases} cfg={s.config} /> },
  { key: 'testCaseReviews', label: 'Test Reviews', hasData: (s) => (s.testCaseReviews?.length ?? 0) > 0, render: (s) => <ReviewList reviews={s.testCaseReviews} /> },
  { key: 'draftPR', label: 'Draft PR', hasData: (s) => !!s.draftPR, render: (s) => <DraftPRView data={s.draftPR} cfg={s.config} /> },
  { key: 'workItemUpdate', label: 'Docs', hasData: (s) => !!s.workItemUpdate, render: (s) => <JsonBlock data={s.workItemUpdate} /> },
  { key: 'docsWriterDrafts', label: 'Docs Drafts', hasData: (s) => !!s.docsWriterDrafts, render: (s) => <JsonBlock data={s.docsWriterDrafts} /> },
  { key: 'humanFeedback', label: 'Human Feedback', hasData: (s) => !!s.humanFeedback, render: (s) => <HumanFeedbackView data={s.humanFeedback} /> },
  { key: 'learnedRules', label: 'Learned Rules', hasData: (s) => !!s.learnedRules, render: (s) => <JsonBlock data={s.learnedRules} /> },
];

function JsonBlock({ data }: { data: any }) {
  return <pre class="json-block">{JSON.stringify(data, null, 2)}</pre>;
}

function Badge({ label, variant }: { label: string; variant?: string }) {
  return <span class={`badge badge--${variant ?? label}`}>{label}</span>;
}

function Section({ title, children }: { title: string; children: any }) {
  return (
    <div class="output-section">
      <h4 class="output-section__title">{title}</h4>
      {children}
    </div>
  );
}

function ReadinessView({ data }: { data: any }) {
  if (!data) return null;
  return (
    <div class="output-structured">
      <div class="output-header">
        <Badge label={data.verdict} />
        {data.summary && <p class="output-summary">{data.summary}</p>}
      </div>
      {data.gaps?.length > 0 && (
        <Section title="Gaps">
          {data.gaps.map((g: any, i: number) => (
            <div key={i} class={`gap-item gap-item--${g.severity}`}>
              <div class="gap-item__header">
                <strong>{g.field}</strong>
                <Badge label={g.severity} />
                {g.resolvedByAgent && <Badge label="resolved" variant="resolved" />}
              </div>
              <p class="gap-item__question">{g.question}</p>
              {g.resolution && <p class="gap-item__resolution">{g.resolution}</p>}
            </div>
          ))}
        </Section>
      )}
      {data.enrichedContext && (
        <Section title="Enriched Context">
          <div class="context-grid">
            <div class="context-field"><label>Type</label><span>{data.enrichedContext.type}</span></div>
            <div class="context-field"><label>Title</label><span>{data.enrichedContext.title}</span></div>
            <div class="context-field context-field--full"><label>Target Area</label><span>{data.enrichedContext.targetArea}</span></div>
            <div class="context-field context-field--full"><label>Description</label><p>{data.enrichedContext.description}</p></div>
            {data.enrichedContext.acceptanceCriteria && (
              <div class="context-field context-field--full"><label>Acceptance Criteria</label><pre class="context-pre">{data.enrichedContext.acceptanceCriteria}</pre></div>
            )}
            {data.enrichedContext.codebaseInsights?.length > 0 && (
              <div class="context-field context-field--full">
                <label>Codebase Insights</label>
                <ul class="context-list">{data.enrichedContext.codebaseInsights.map((c: string, i: number) => <li key={i}>{c}</li>)}</ul>
              </div>
            )}
            {data.enrichedContext.relatedWorkItems?.length > 0 && (
              <div class="context-field context-field--full">
                <label>Related Work Items</label>
                <ul class="context-list">{data.enrichedContext.relatedWorkItems.map((w: any, i: number) => <li key={i}>#{w.id} — {w.title} ({w.relationship})</li>)}</ul>
              </div>
            )}
          </div>
        </Section>
      )}
    </div>
  );
}

function DevPlanView({ data }: { data: any }) {
  if (!data) return null;
  return (
    <div class="output-structured">
      <div class="output-header">
        <Badge label={data.estimatedComplexity} variant="complexity" />
        {data.riskAssessment && <Badge label={`risk: ${data.riskAssessment.level}`} variant={`risk-${data.riskAssessment.level}`} />}
        {data.summary && <p class="output-summary">{data.summary}</p>}
      </div>
      {data.objects?.length > 0 && (
        <Section title={`AL Objects (${data.objects.length})`}>
          <table class="plan-table">
            <thead><tr><th>Action</th><th>Type</th><th>Name</th><th>Description</th></tr></thead>
            <tbody>
              {data.objects.map((o: any, i: number) => (
                <tr key={i}>
                  <td><Badge label={o.action} /></td>
                  <td>{o.objectType}{o.objectId ? ` ${o.objectId}` : ''}</td>
                  <td class="plan-table__name">{o.objectName}</td>
                  <td>{o.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      {data.testScenarios?.length > 0 && (
        <Section title={`Test Scenarios (${data.testScenarios.length})`}>
          {data.testScenarios.map((t: any, i: number) => (
            <div key={i} class="test-scenario">
              <strong>{t.name}</strong>
              <p>{t.description}</p>
              <div class="test-scenario__meta">
                <span>Expected: {t.expectedOutcome}</span>
                <span class="test-scenario__derived">From: {t.derivedFrom}</span>
              </div>
            </div>
          ))}
        </Section>
      )}
      {data.riskAssessment && (
        <Section title="Risk Assessment">
          <div class={`risk-card risk-card--${data.riskAssessment.level}`}>
            {data.riskAssessment.factors?.length > 0 && (
              <div><strong>Factors</strong><ul class="context-list">{data.riskAssessment.factors.map((f: string, i: number) => <li key={i}>{f}</li>)}</ul></div>
            )}
            {data.riskAssessment.mitigations?.length > 0 && (
              <div><strong>Mitigations</strong><ul class="context-list">{data.riskAssessment.mitigations.map((m: string, i: number) => <li key={i}>{m}</li>)}</ul></div>
            )}
          </div>
        </Section>
      )}
      {data.dependencies?.length > 0 && (
        <Section title="Dependencies">
          <ul class="context-list">{data.dependencies.map((d: string, i: number) => <li key={i}>{d}</li>)}</ul>
        </Section>
      )}
      {data.notes && (
        <Section title="Notes">
          <p class="output-summary">{data.notes}</p>
        </Section>
      )}
    </div>
  );
}

function ChangesetView({ data, cfg }: { data: any; cfg?: AdoCfg }) {
  const base = adoBase(cfg);
  if (!data) return null;
  return (
    <div class="output-structured">
      <div class="output-header">
        {data.ciResult && <Badge label={data.ciResult} variant={data.ciResult === 'passed' ? 'resolved' : 'reject'} />}
        {data.commitMessage && <p class="output-summary"><strong>{data.commitMessage}</strong></p>}
      </div>
      {data.summary && <p class="output-summary">{data.summary}</p>}
      <div class="context-grid">
        {data.branchName && (
          <div class="context-field">
            <label>Branch</label>
            {data.branchUrl
              ? <a href={data.branchUrl} target="_blank" rel="noopener" style={{ color: 'var(--color-accent)', textDecoration: 'none', fontSize: '0.8rem', fontFamily: 'var(--font-mono)' }}>{data.branchName}</a>
              : <code>{data.branchName}</code>}
          </div>
        )}
        {data.commitHash && (
          <div class="context-field"><label>Commit</label><code>{data.commitHash.slice(0, 12)}</code></div>
        )}
        {data.ciRunId && (
          <div class="context-field">
            <label>CI Pipeline</label>
            {base
              ? <a href={`${base}/_build/results?buildId=${data.ciRunId}`} target="_blank" rel="noopener" style={{ color: 'var(--color-accent)', textDecoration: 'none', fontSize: '0.8rem' }}>Run #{data.ciRunId}</a>
              : <code style={{ fontSize: '0.8rem' }}>Run #{data.ciRunId}</code>}
          </div>
        )}
      </div>
      {data.filesModified?.length > 0 && (
        <Section title={`Files Modified (${data.filesModified.length})`}>
          <ul class="context-list">{data.filesModified.map((f: string, i: number) => <li key={i}><code style={{ fontSize: '0.8rem' }}>{f}</code></li>)}</ul>
        </Section>
      )}
      {data.filesCreated?.length > 0 && (
        <Section title={`Files Created (${data.filesCreated.length})`}>
          <ul class="context-list">{data.filesCreated.map((f: string, i: number) => <li key={i}><code style={{ fontSize: '0.8rem' }}>{f}</code></li>)}</ul>
        </Section>
      )}
      {data.compilationErrors?.length > 0 && (
        <Section title={`Compilation Errors (${data.compilationErrors.length})`}>
          <ul class="context-list">{data.compilationErrors.map((e: string, i: number) => <li key={i} style={{ color: 'var(--color-error)' }}>{e}</li>)}</ul>
        </Section>
      )}
      {data.failedTests?.length > 0 && (
        <Section title={`Failed Tests (${data.failedTests.length})`}>
          <ul class="context-list">{data.failedTests.map((t: string, i: number) => <li key={i} style={{ color: 'var(--color-error)' }}>{t}</li>)}</ul>
        </Section>
      )}
    </div>
  );
}

function TestCasesView({ data, cfg }: { data: any; cfg?: AdoCfg }) {
  if (!data) return null;
  const base = adoBase(cfg);
  const cases = data.testCases ?? [];
  return (
    <div class="output-structured">
      {data.summary && (
        <div class="output-header">
          <Badge label={`${cases.length} test cases`} variant="complexity" />
          <p class="output-summary">{data.summary}</p>
        </div>
      )}
      {cases.length > 0 && (
        <Section title={`Test Cases (${cases.length})`}>
          <table class="plan-table">
            <thead><tr><th>ID</th><th>Title</th><th>Steps</th><th>Derived From</th></tr></thead>
            <tbody>
              {cases.map((tc: any, i: number) => (
                <tr key={i}>
                  <td>
                    {tc.id
                      ? (base
                          ? <a href={`${base}/_workitems/edit/${tc.id}`} target="_blank" rel="noopener" style={{ color: 'var(--color-accent)', textDecoration: 'none' }}>#{tc.id}</a>
                          : <span>#{tc.id}</span>)
                      : '—'}
                  </td>
                  <td>{tc.title}</td>
                  <td style={{ textAlign: 'center' }}>{tc.stepCount ?? '—'}</td>
                  <td style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>{tc.derivedFrom ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </div>
  );
}

function DraftPRView({ data, cfg }: { data: any; cfg?: AdoCfg }) {
  if (!data) return null;
  const base = adoBase(cfg);
  return (
    <div class="output-structured">
      <div class="output-header">
        {data.isDraft && <Badge label="draft" variant="needs-input" />}
        {data.url
          ? <a href={data.url} target="_blank" rel="noopener" style={{ color: 'var(--color-accent)', textDecoration: 'none', fontWeight: 600, fontSize: '0.95rem' }}>{data.title ?? `PR #${data.id}`}</a>
          : <strong>{data.title ?? `PR #${data.id}`}</strong>}
      </div>
      <div class="context-grid">
        {data.sourceBranch && <div class="context-field"><label>Source</label><code>{data.sourceBranch}</code></div>}
        {data.targetBranch && <div class="context-field"><label>Target</label><code>{data.targetBranch}</code></div>}
        {data.linkedWorkItemId && (
          <div class="context-field">
            <label>Work Item</label>
            {base
              ? <a href={`${base}/_workitems/edit/${data.linkedWorkItemId}`} target="_blank" rel="noopener" style={{ color: 'var(--color-accent)', textDecoration: 'none' }}>#{data.linkedWorkItemId}</a>
              : <span>#{data.linkedWorkItemId}</span>}
          </div>
        )}
      </div>
      {data.description && (
        <Section title="Description">
          <pre class="context-pre" style={{ whiteSpace: 'pre-wrap', lineHeight: '1.5' }}>{data.description}</pre>
        </Section>
      )}
    </div>
  );
}

/**
 * Render HTML-ish feedback (authored via ADO comments) as clean text:
 * block tags → newlines, strip remaining tags, decode common entities.
 * Pure string ops — no innerHTML, so no injection surface.
 */
function htmlToText(input: unknown): string {
  if (typeof input !== 'string') return '';
  let s = input;
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\s*\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n');
  s = s.replace(/<\s*li[^>]*>/gi, '• ');
  s = s.replace(/<[^>]+>/g, ''); // strip remaining tags
  const entities: Record<string, string> = {
    '&quot;': '"', '&#34;': '"', '&#39;': "'", '&apos;': "'",
    '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–',
  };
  for (const [ent, ch] of Object.entries(entities)) s = s.replaceAll(ent, ch);
  s = s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  s = s.replaceAll('&amp;', '&'); // last, so &amp;lt; → &lt; isn't double-decoded above
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

function HumanFeedbackView({ data }: { data: any }) {
  if (!data) return null;
  const prComments: any[] = data.prReviewComments ?? [];
  const wiComments: any[] = data.workItemComments ?? [];
  const testFailures: any[] = data.testCaseFailures ?? [];
  return (
    <div class="output-structured">
      {data.source && (
        <div class="output-header">
          <Badge label={data.source} />
        </div>
      )}
      {data.rerunComment && (
        <Section title="Feedback">
          <pre class="context-pre" style={{ whiteSpace: 'pre-wrap', lineHeight: '1.5' }}>{htmlToText(data.rerunComment)}</pre>
        </Section>
      )}
      {data.commentSummary && (
        <Section title="Comment Summary">
          <pre class="context-pre" style={{ whiteSpace: 'pre-wrap', lineHeight: '1.5' }}>{htmlToText(data.commentSummary)}</pre>
        </Section>
      )}
      {prComments.length > 0 && (
        <Section title={`PR Review Comments (${prComments.length})`}>
          {prComments.map((c, i) => (
            <div key={i} class="feedback-comment">
              <div class="feedback-comment__header">
                <strong>{c.author}</strong>
                {c.filePath && <code class="feedback-comment__loc">{c.filePath}{c.line ? `:${c.line}` : ''}</code>}
                {c.publishedDate && <span class="feedback-comment__date">{new Date(c.publishedDate).toLocaleString()}</span>}
              </div>
              <p class="feedback-comment__body">{htmlToText(c.content)}</p>
            </div>
          ))}
        </Section>
      )}
      {wiComments.length > 0 && (
        <Section title={`Work Item Comments (${wiComments.length})`}>
          {wiComments.map((c, i) => (
            <div key={i} class="feedback-comment">
              <div class="feedback-comment__header">
                <strong>{c.author}</strong>
                {c.createdDate && <span class="feedback-comment__date">{new Date(c.createdDate).toLocaleString()}</span>}
              </div>
              <p class="feedback-comment__body">{htmlToText(c.text)}</p>
            </div>
          ))}
        </Section>
      )}
      {testFailures.length > 0 && (
        <Section title={`Test Case Failures (${testFailures.length})`}>
          {testFailures.map((t, i) => (
            <div key={i} class="test-scenario">
              <div class="feedback-comment__header">
                <strong>#{t.testCaseId} — {t.title}</strong>
                {t.outcome && <Badge label={t.outcome} variant="reject" />}
              </div>
              {(t.failedSteps?.length ?? 0) > 0 && (
                <ul class="context-list">
                  {t.failedSteps.map((s: any, j: number) => (
                    <li key={j}>
                      Step {s.stepNumber}: {s.action} — expected {s.expectedResult}
                      {s.comment ? ` (${s.comment})` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}

function ReviewList({ reviews }: { reviews?: any[] }) {
  if (!reviews || reviews.length === 0) return <p class="empty-state">No reviews.</p>;
  return (
    <div class="review-list">
      {reviews.map((r, i) => (
        <div key={i} class={`review-item review-item--${r.verdict}`}>
          <span class="review-item__verdict">{r.verdict}</span>
          <pre class="review-item__feedback">{r.feedback}</pre>
        </div>
      ))}
    </div>
  );
}

interface Props { session: DashboardSession; }

export function AgentOutputTabs({ session }: Props) {
  const availableTabs = TABS.filter((t) => t.hasData(session));
  if (availableTabs.length === 0) return null;
  const current = availableTabs.find((t) => t.key === activeTab.value) ?? availableTabs[0]!;

  return (
    <div class="output-tabs">
      <div class="output-tabs__nav">
        {availableTabs.map((tab) => (
          <button
            type="button"
            key={tab.key}
            class={`output-tabs__tab ${tab.key === current!.key ? 'output-tabs__tab--active' : ''}`}
            onClick={() => { activeTab.value = tab.key; }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div class="output-tabs__content">{current!.render(session)}</div>
    </div>
  );
}
