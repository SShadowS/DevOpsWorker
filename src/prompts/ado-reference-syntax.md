# Azure DevOps Reference Syntax

When writing text that lands in Azure DevOps (work item comments, PR descriptions, PR comments, plans, analyses, release notes):

- **Work items:** `#<id>` (e.g., `#12345`) — auto-links to the work item.
- **Pull requests:** `!<id>` (e.g., `!456`) — auto-links to the PR. Never use `#` for PRs; that links to a work item instead.
- **Zendesk tickets:** Azure DevOps has NO shortform link for Zendesk. Never write `#<id>` or `!<id>` for a ticket — both create wrong links. Write "Zendesk ticket 12345" in plain text, or use the full ticket URL when you have it.
