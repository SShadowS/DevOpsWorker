import { describe, test, expect } from 'bun:test';
import {
  PipelineError,
  AgentExecutionError,
  AgentValidationError,
  PreconditionError,
  ExternalServiceError,
  BudgetExceededError,
  CheckpointTimeoutError,
  RevisionExhaustedError,
  PreflightError,
  TransientAgentError,
} from '../../src/sdk/errors.ts';

describe('PipelineError', () => {
  test('sets all properties correctly', () => {
    const err = new PipelineError('my-type', 'my-stage', 'something went wrong');
    expect(err.type).toBe('my-type');
    expect(err.stage).toBe('my-stage');
    expect(err.message).toBe('something went wrong');
    expect(err.name).toBe('PipelineError');
    expect(typeof err.timestamp).toBe('string');
    expect(err.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('accepts an explicit timestamp', () => {
    const ts = '2024-01-01T00:00:00.000Z';
    const err = new PipelineError('t', 's', 'msg', ts);
    expect(err.timestamp).toBe(ts);
  });

  test('extends Error', () => {
    const err = new PipelineError('t', 's', 'msg');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('AgentExecutionError', () => {
  test('sets type, stage, name correctly', () => {
    const err = new AgentExecutionError('my-agent', 'something broke');
    expect(err.type).toBe('agent-execution');
    expect(err.stage).toBe('my-agent');
    expect(err.name).toBe('AgentExecutionError');
  });

  test('uses string details as message', () => {
    const err = new AgentExecutionError('my-agent', 'explicit error text');
    expect(err.message).toBe('explicit error text');
    expect(err.details).toBe('explicit error text');
  });

  test('uses default message for non-string details', () => {
    const details = { code: 42 };
    const err = new AgentExecutionError('my-agent', details);
    expect(err.message).toBe('Agent "my-agent" failed to produce a result');
    expect(err.details).toBe(details);
  });

  test('extends PipelineError and Error', () => {
    const err = new AgentExecutionError('s', 'msg');
    expect(err).toBeInstanceOf(PipelineError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('AgentValidationError', () => {
  test('sets all properties correctly', () => {
    const zodError = { issues: [] };
    const err = new AgentValidationError('my-agent', zodError);
    expect(err.type).toBe('agent-validation');
    expect(err.stage).toBe('my-agent');
    expect(err.name).toBe('AgentValidationError');
    expect(err.message).toBe('Agent "my-agent" output failed schema validation');
    expect(err.zodError).toBe(zodError);
  });

  test('extends PipelineError and Error', () => {
    const err = new AgentValidationError('s', {});
    expect(err).toBeInstanceOf(PipelineError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('PreconditionError', () => {
  test('sets all properties correctly', () => {
    const err = new PreconditionError('my-stage', 'required field missing');
    expect(err.type).toBe('precondition');
    expect(err.stage).toBe('my-stage');
    expect(err.name).toBe('PreconditionError');
    expect(err.message).toBe('required field missing');
  });

  test('extends PipelineError and Error', () => {
    const err = new PreconditionError('s', 'msg');
    expect(err).toBeInstanceOf(PipelineError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('ExternalServiceError', () => {
  test('formats message as "service: message"', () => {
    const err = new ExternalServiceError('my-stage', 'Azure DevOps', 'rate limit exceeded');
    expect(err.type).toBe('external-service');
    expect(err.stage).toBe('my-stage');
    expect(err.name).toBe('ExternalServiceError');
    expect(err.message).toBe('Azure DevOps: rate limit exceeded');
  });

  test('extends PipelineError and Error', () => {
    const err = new ExternalServiceError('s', 'svc', 'msg');
    expect(err).toBeInstanceOf(PipelineError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('BudgetExceededError', () => {
  test('formats message with two decimal places', () => {
    const err = new BudgetExceededError('my-stage', 10.5, 8);
    expect(err.type).toBe('budget-exceeded');
    expect(err.stage).toBe('my-stage');
    expect(err.name).toBe('BudgetExceededError');
    expect(err.message).toBe('Budget exceeded: $10.50 > $8.00');
  });

  test('handles integer amounts', () => {
    const err = new BudgetExceededError('s', 5, 3);
    expect(err.message).toBe('Budget exceeded: $5.00 > $3.00');
  });

  test('extends PipelineError and Error', () => {
    const err = new BudgetExceededError('s', 1, 0);
    expect(err).toBeInstanceOf(PipelineError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('CheckpointTimeoutError', () => {
  test('sets all properties correctly', () => {
    const err = new CheckpointTimeoutError('plan-approval', 24);
    expect(err.type).toBe('checkpoint-timeout');
    expect(err.stage).toBe('plan-approval');
    expect(err.name).toBe('CheckpointTimeoutError');
    expect(err.message).toBe('Checkpoint "plan-approval" timed out after 24 hours');
  });

  test('extends PipelineError and Error', () => {
    const err = new CheckpointTimeoutError('s', 1);
    expect(err).toBeInstanceOf(PipelineError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('RevisionExhaustedError', () => {
  test('sets all properties correctly without lastState', () => {
    const err = new RevisionExhaustedError('planning', 3);
    expect(err.type).toBe('revision-exhausted');
    expect(err.stage).toBe('planning');
    expect(err.name).toBe('RevisionExhaustedError');
    expect(err.message).toBe('Revision loop "planning" exhausted 3 attempts without approval');
    expect(err.lastState).toBeUndefined();
  });

  test('stores lastState when provided', () => {
    const state = { workItemId: 42 } as never;
    const err = new RevisionExhaustedError('planning', 3, state);
    expect(err.lastState).toBe(state);
  });

  test('extends PipelineError and Error', () => {
    const err = new RevisionExhaustedError('s', 1);
    expect(err).toBeInstanceOf(PipelineError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('PreflightError', () => {
  test('formats summary from checks array', () => {
    const checks = [
      { name: 'auth', message: 'token missing' },
      { name: 'db', message: 'connection refused' },
    ];
    const err = new PreflightError(checks);
    expect(err.type).toBe('preflight');
    expect(err.stage).toBe('preflight');
    expect(err.name).toBe('PreflightError');
    expect(err.checks).toBe(checks);
    expect(err.message).toBe(
      'Preflight checks failed:\n  - auth: token missing\n  - db: connection refused',
    );
  });

  test('handles a single check', () => {
    const checks = [{ name: 'env', message: 'AZURE_DEVOPS_PAT not set' }];
    const err = new PreflightError(checks);
    expect(err.message).toBe('Preflight checks failed:\n  - env: AZURE_DEVOPS_PAT not set');
  });

  test('extends PipelineError and Error', () => {
    const err = new PreflightError([{ name: 'x', message: 'y' }]);
    expect(err).toBeInstanceOf(PipelineError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('TransientAgentError', () => {
  test('sets all properties correctly', () => {
    const cause = new Error('network timeout');
    const err = new TransientAgentError('my-agent', 3, cause);
    expect(err.type).toBe('transient-agent');
    expect(err.stage).toBe('my-agent');
    expect(err.name).toBe('TransientAgentError');
    expect(err.attempts).toBe(3);
    expect(err.lastError).toBe(cause);
    expect(err.message).toBe('Agent "my-agent" failed after 3 attempt(s): network timeout');
  });

  test('singular attempt phrasing', () => {
    const cause = new Error('oops');
    const err = new TransientAgentError('s', 1, cause);
    expect(err.message).toBe('Agent "s" failed after 1 attempt(s): oops');
  });

  test('extends PipelineError and Error', () => {
    const err = new TransientAgentError('s', 1, new Error('x'));
    expect(err).toBeInstanceOf(PipelineError);
    expect(err).toBeInstanceOf(Error);
  });
});
