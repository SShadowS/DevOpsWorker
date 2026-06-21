#!/usr/bin/env bun
/**
 * resume-wi.ts — prepare a work item for the watcher's resume path.
 *
 * The watcher resumes an error-state item when: `plan-approved` tag present,
 * `need-input` tag absent, and state.error set. This script reports current tags
 * and (with --apply) ensures plan-approved is present and need-input is removed.
 *
 *   bun scripts/resume-wi.ts <workItemId>           # dry-run: show tags
 *   bun scripts/resume-wi.ts <workItemId> --apply   # set tags for resume
 */
import { connectStores } from '../src/db/connect-stores.ts';
import { loadConfigFromState } from '../src/cli/config.ts';
import { fetchWorkItem, addWorkItemTags, removeWorkItemTags } from '../src/sdk/azure-devops-client.ts';

const workItemId = Number(process.argv[2]);
const apply = process.argv.includes('--apply');
if (!workItemId) throw new Error('usage: resume-wi.ts <workItemId> [--apply]');

const stores = await connectStores();
const config = await loadConfigFromState(stores.stateStore, workItemId);

const wi = await fetchWorkItem(workItemId, config);
console.log(`Current tags: ${JSON.stringify(wi.tags)}`);

if (apply) {
  await removeWorkItemTags(workItemId, ['need-input'], config);
  await addWorkItemTags(workItemId, ['plan-approved'], config);
  const after = await fetchWorkItem(workItemId, config);
  console.log(`After:        ${JSON.stringify(after.tags)}`);
  console.log('Watcher should re-dispatch continue on its next poll.');
} else {
  console.log('Dry-run. Re-run with --apply to set plan-approved + remove need-input.');
}

process.exit(0);
