# Documentation Writing Style Guide

This is a generic style guide for drafting end-user documentation pages for a
Business Central extension. If your docs site has its own conventions (frontmatter
schema, ID scheme, template tags, terminology table), document them in the private
overlay copy — `<PRIVATE_DIR>/prompts/doc-writing-style.md` — which overrides this
file.

## Voice & Tone

- **Second person** ("you", "your") — address the reader directly.
- **Professional but approachable** — clear, concise, no marketing fluff.
- **Action-oriented** — prefer active voice ("Choose the icon", not "The icon should be chosen").
- **Present tense** — "This feature enables..." not "This feature will enable..."
- Contractions are fine.

## Page Structure

- One **H1** per page, matching the page title.
- **H2** for major sections; **H3** for sub-sections.
- Common closing section: `## Related information` with links to related pages.
- How-to pages: a `## To [verb phrase]` section with numbered steps.
- FAQ pages: `## Question` / `## Answer`.

## Formatting

- **Bold** for UI elements and field names.
- Numbered lists (`1.` for every item) for sequential steps; bullet lists for non-sequential items.
- Use platform callouts where supported: `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`.
- **FastTab** and **FactBox** are single words (capital F + T / F + B) for BC page sections and side panels.
- Keep paragraphs short (2–4 sentences). No trailing whitespace; end files with a newline.

## Terminology

- Use **Business Central** (not BC/NAV, unless referencing legacy versions).
- Use **on-premises** (not on-premise), **email** (not e-mail), **codeunit** (one word).

## Do's and Don'ts

**Do:** jump straight into the content; use tables for structured comparisons; keep pages concise.

**Don't:** start with "In this article…"; use first person ("I"/"we"); add a manual table of contents; reference internal object IDs in user-facing prose.
