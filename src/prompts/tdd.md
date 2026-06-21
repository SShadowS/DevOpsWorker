# Test-Driven Development

Red → green → refactor. The test describes the behavior; the code makes it pass.

## Rules

- **Test first.** Write the test for the current acceptance criterion before implementing the behavior that satisfies it.
- **AL compile exception.** If a test cannot compile without new AL object, field, enum, procedure, or codeunit declarations, add only the minimal skeleton needed to compile the test. Do not implement behavior before the test exists.
- **Red evidence required; failing commits are not.** Prefer a targeted/local test run to prove red. If AL tests require a slow remote Business Central environment, the final changeset may contain the test and implementation together, but the coder must state why the test would have failed without the implementation. Final required CI must be green.
- **Smallest spec-compliant change.** Implement only the behavior needed for the current tested plan item. Do not add unplanned or untested behavior.
- **Acceptance criteria need coverage.** Every acceptance criterion needs automated test coverage unless the approved plan explicitly marks it non-automatable and defines another verification method.
- **Test behavior, not wiring.** Test observable behavior and externally relevant side effects, not private structure or incidental implementation details.
- **No disabled tests as coverage.** Do not comment out tests or use `[Ignore]` to make CI pass. `[Ignore]` is allowed only when the approved plan explicitly calls for a known-broken or quarantined test and includes the reason and tracking reference. Ignored tests do not count toward acceptance-criterion coverage.

## Review gates

Reviewers must reject work that:

- claims acceptance coverage from skipped, ignored, or commented-out tests;
- ships implementation without a corresponding test or approved non-automated verification path.
