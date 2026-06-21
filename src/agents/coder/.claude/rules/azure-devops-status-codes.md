# Azure DevOps Status Codes Reference

## Pull Request Status (`status` field)

| Value | Status | Description |
|-------|--------|-------------|
| 0 | NotSet | Status not set |
| 1 | **Active** | PR is open and awaiting review/merge |
| 2 | Abandoned | PR was abandoned/closed without merging |
| 3 | Completed | PR was merged successfully |

**Common mistake:** Status `1` means **Active** (open), NOT completed.

## Merge Status (`mergeStatus` field)

| Value | Status | Description |
|-------|--------|-------------|
| 0 | NotSet | Merge status not evaluated |
| 1 | Queued | Merge is queued |
| 2 | Conflicts | Merge has conflicts that need resolution |
| 3 | **Succeeded** | Merge is possible (no conflicts) |
| 4 | RejectedByPolicy | Merge blocked by branch policy |
| 5 | Failure | Merge failed |

**Common mistake:** `mergeStatus: 3` (Succeeded) means the merge CAN succeed (no conflicts), NOT that the PR was already merged.

## Other Important Fields

- `lastMergeCommit`: This is a **preview merge commit** created by Azure DevOps to check for conflicts. It does NOT indicate the PR was merged.
- `autoCompleteSetBy`: Indicates auto-complete is enabled, not that the PR completed.
- `completionOptions`: Configuration for when/if the PR completes, not proof of completion.

## How to Determine PR State

1. Check `status` field first:
   - `status: 1` = PR is still open
   - `status: 3` = PR is completed/merged
2. If `status: 1`, check `mergeStatus`:
   - `mergeStatus: 3` = Ready to merge (no conflicts)
   - `mergeStatus: 2` = Has conflicts
