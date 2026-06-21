# Spec-Driven Development

The approved development plan is the spec. Build, test, and review only against that spec.

## Rules

- **Approved plan is authoritative until revised.** Implement only the approved plan.
- **No silent scope changes.** No scope creep, no "while I'm here" extras, and no silent omissions.
- **If the plan is wrong, stop and request a plan revision.** A gap, ambiguity, or contradiction is not permission to improvise. Continue only after the revised plan is approved.
- **Every code change and test must trace to the plan.** If it cannot be mapped to a plan step, requirement, or acceptance criterion, it does not belong in the changeset.
- **Plans must be testable.** Acceptance criteria must be specific enough to drive tests or explicit verification.
- **No invented product behavior.** Boundary, negative, and regression cases are allowed when they validate a stated requirement or acceptance criterion. Otherwise, request a plan revision.

## Review gates

Reviewers must reject work that:

- lacks testable acceptance criteria;
- cannot be traced to the approved plan;
- exceeds, contradicts, or omits the approved plan;
- adds behavior without corresponding tests or approved verification.
