# Required Azure DevOps Work Item Fields

The concrete area/iteration paths and any custom fields are supplied per
deployment via the private overlay
(`<PRIVATE_DIR>/prompts/work-item-fields.md`, which overrides this file).

- **Area Path:** `<your-area-path>`
- **Iteration Path:** `<your-iteration-path>`
- **Release Notes field:** a customer-facing description of the change (if your
  process uses one)

## Release Notes Guidelines

- Start with action words: "Fixed", "Added", "Improved", "Updated"
- Write from the customer's perspective, not the developer's
- Use non-technical language — describe the benefit, not the code change
- **Good:** "Fixed permission issue where users in the Sales role could not post orders"
- **Bad:** "Updated SalesPermissions.al line 39 to change TableData permissions from r to rimd"

## Description Template (HTML)

If your team uses a standard work-item description template, document its sections
in the overlay copy. A common structure:

1. **Error Details** — What the user experiences
2. **Root Cause** — Why the issue occurs
3. **Solution** — What was changed to fix it
4. **Impact** — Who is affected and any side effects
