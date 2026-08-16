---
name: DevOpsWorker Dashboard
description: A flat, dark, information-dense operating surface where colour means state and the accent means a person is needed.
colors:
  bg-primary: "#0f172a"
  bg-secondary: "#1e293b"
  bg-tertiary: "#263548"
  text-primary: "#e2e8f0"
  text-secondary: "#94a3b8"
  text-muted: "#64748b"
  border: "#334155"
  border-muted: "#1e293b"
  accent: "#e5a00d"
  accent-dim: "rgba(229, 160, 13, 0.15)"
  success: "#22c55e"
  info: "#3b82f6"
  info-text: "#93c5fd"
  warning: "#f59e0b"
  error: "#ef4444"
  error-text: "#ff8a8a"
  stage-pending: "#475569"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "1.2rem"
    fontWeight: 600
    lineHeight: 1.3
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.8rem"
    fontWeight: 400
    lineHeight: 1.5
  prose:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.82rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.7rem"
    fontWeight: 600
    letterSpacing: "0.03em"
  mono:
    fontFamily: "'Cascadia Code', 'Fira Code', monospace"
    fontSize: "0.8rem"
    fontWeight: 400
rounded:
  mark: "3px"
  control: "4px"
  card: "6px"
  badge: "10px"
  dot: "50%"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button:
    backgroundColor: "{colors.bg-tertiary}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.card}"
    padding: "6px 16px"
  button-primary:
    backgroundColor: "{colors.success}"
    textColor: "{colors.bg-primary}"
    rounded: "{rounded.card}"
    padding: "6px 16px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.card}"
    padding: "6px 16px"
  badge-severity:
    textColor: "{colors.warning}"
    typography: "{typography.label}"
    rounded: "{rounded.badge}"
    padding: "1px 8px"
  panel-section:
    backgroundColor: "{colors.bg-tertiary}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
  panel-slot:
    backgroundColor: "{colors.bg-secondary}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.card}"
    padding: "16px"
  input:
    backgroundColor: "{colors.bg-tertiary}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.control}"
    padding: "6px 10px"
---

# Design System: DevOpsWorker Dashboard

## Overview

**Creative North Star: "The Instrument Panel"**

This is a cockpit read at a glance by the person responsible for the machine. Density is
not clutter here, it is respect for the operator's time: they came to answer a question
(is anything wrong, what did that cost, what needs me) and every row they have to scroll
past is a row that delayed the answer. The interface is calm until something genuinely
needs a hand, and then exactly one colour says so.

The system earns its character semantically rather than decoratively. In roughly 3,200
lines of CSS there are two shadows, one gradient, no blur, and no web fonts — the
sophistication is entirely in what colour, stripe width, and shape are allowed to *mean*.
A reading is either trustworthy or explicitly absent; "no data yet", "not recorded", and
"still loading" are drawn states, never blank space. That refusal to guess is the
product's own discipline made visible.

Confirmed anti-reference: nothing here is a marketing surface. No hero metrics, no
decorative gradients, no ornamental motion. When a choice is genuinely 50/50, the
tie-breaker is **dense and legible** — pack the real information in, then earn
readability through rhythm and hierarchy rather than by spending whitespace.

**Key Characteristics:**
- Flat and tonally layered; depth comes from a three-step background ladder, not shadow
- One protected accent (amber) meaning "a person must act", and nothing else
- Colour always paired with words — colour is never the only signal
- Uppercase micro-labels over dense tables; prose sentences carry the meaning
- System fonts only; the interface loads nothing it does not need
- Contrast is audited in the stylesheet itself, with measured ratios in the comments

## Colors

A cool slate ground with a single warm accent, plus a four-colour semantic vocabulary
that never drifts in meaning between surfaces.

### Primary
- **Signal Amber** (`#e5a00d`): the protected accent. It means one thing — *a person must
  act*. It appears on the header wordmark, a session card waiting at a checkpoint, the
  keyboard focus ring, an attention item in the status ribbon, and the pending-proposal
  badge. It is not a brand flourish and not a selection colour.

### Secondary
The four state colours. Each has exactly one meaning, and that meaning holds on every
surface it touches (stripes, badges, pills, bars, dots, stage nodes).
- **Running Green** (`#22c55e`): finished well, approved, low risk, ready.
- **In-Flight Blue** (`#3b82f6`): running, loading, being reviewed. Also the focus
  border on native form fields.
- **Stalled Amber** (`#f59e0b`): stalled, needs revision, needs clarification, medium
  risk. Distinct in role from Signal Amber: this describes a *thing's state*, that one
  demands *your action*.
- **Failure Red** (`#ef4444`): failed, blocking, high risk.

### Tertiary
Two text-only siblings that exist for contrast, not for a new meaning.
- **Legible Red** (`#ff8a8a`): error text on dark surfaces. Failure Red measures 3.89:1
  on the card surface — under AA, and error text is precisely what an operator must read
  when something has gone wrong.
- **Legible Blue** (`#93c5fd`): info text on tinted badges, where the saturated blue
  measured 3.15:1 blue-on-blue.

### Neutral
- **Deep Slate** (`#0f172a`): the page ground, and the inside of a scrolling code or
  diff surface.
- **Card Slate** (`#1e293b`): a thing that is its own row — session card, stats slot,
  login card.
- **Inset Slate** (`#263548`): a thing inside a card — a section, a table header, an
  input. Also the hover ground.
- **Primary Ink** (`#e2e8f0`): values, headings, anything being read for content.
- **Secondary Ink** (`#94a3b8`): the house default for prose and labels. It, not the
  muted tier, is where explanatory sentences belong.
- **Muted Ink** (`#64748b`): timestamps and inert marks only.
- **Rule** (`#334155`) and **Faint Rule** (`#1e293b`): 1px borders and table cell
  divisions.
- **Dormant** (`#475569`): not started, neutral, done-and-uninteresting.

### Named Rules

**The Reserved Accent Rule.** Signal Amber means "a person must act" and nothing else.
Not "currently selected", not "this is a test run", not "this is important". A label
that wants attention gets a badge with words in it; the accent has one slot and human
action has first claim.

**The Colour-Plus-Words Rule.** Colour is never the only carrier of a fact. An attention
state renders its colour *and* a sentence naming what needs attention. A provenance bar
is `aria-hidden` precisely because every fact it draws also exists as text beside it.

**The Text-Tier Rule.** Prose is Secondary Ink. Muted Ink is for timestamps and inert
marks, never for a sentence someone is expected to read — measured at 2.6–3.1:1 on these
grounds, it fails AA exactly where reading matters.

## Typography

**Body Font:** the operating system's own UI sans (`-apple-system`, `Segoe UI`, `Roboto`)
**Mono Font:** `Cascadia Code`, then `Fira Code`

**Character:** deliberately voiceless. The interface loads no font of its own; it speaks
in whatever the operator's machine already uses for its own chrome, which is exactly
right for a tool that should disappear into the task. Personality is spent on precision,
not on lettering.

### Hierarchy
- **Display** (600, 1.2rem): the header wordmark and mobile/login titles. There is no
  large type in this system — a dashboard has no hero.
- **Title** (600, 0.95–1rem): a card's name.
- **Body** (400, 0.8rem): table cells and the dominant reading size.
- **Prose** (400, 0.82rem): the explanatory sentence under a panel heading — the size
  that carries most of the meaning on the stats surfaces.
- **Label** (600, 0.7rem, 0.02–0.05em, uppercase): badges, table headers, section
  eyebrows. The system's one ornamental gesture, and it is functional: uppercase plus
  tracking marks "this is a category, not a value."
- **Mono** (0.8rem): identifiers, shas, config keys, diffs, log output. Monospace is
  used for data and measurement only, never as a costume for "technical".

This hierarchy names **roles, not the complete set of values**. The implementation carries
intermediate steps between these anchors (0.65, 0.68, 0.72, 0.78, 0.85, 0.9rem and a few
others) where a specific component needed a specific optical fit. That is accepted: pick
the role you are filling and use its anchor, and reach for an in-between value only when
the anchor genuinely does not fit. A tooling scan comparing literal sizes against this
list will report those intermediates — they are known, not drift.

### Named Rules

**The Tabular Figures Rule.** A number that updates in place (a tool count, a headline
figure) sets `font-variant-numeric: tabular-nums`, so digits changing never make the
layout twitch.

**The No-Hero-Number Rule.** The largest figure on a stats card is 1.05rem. A metric
earns attention by being *first* and *explained*, not by being enormous.

## Layout

One constrained column (`max-width: 1400px`) with `24px` page padding, dropping to `8px`
on mobile. Inside it, flex columns with token gaps do nearly all the work; grid appears
only where two axes genuinely exist — definition lists (`minmax(180px, max-content) 1fr`),
the tool-usage bar rows (`12rem 1fr 3rem`), the timeline (`140px 1fr 80px`).

The spacing scale is `4 / 8 / 16 / 24 / 32`, used for padding, gap, and margin. It is a
convenience rather than a cage: one-off values (2px, 6px, 10px) appear where a component
needs a specific optical fit, and that is accepted.

Density is the point. Table cells sit at `2–3px` vertical padding, cards at `8–16px`,
row gaps at `4–8px` — an operator sees many rows at once.

Responsive behaviour is structural, never fluid type. There is one real breakpoint at
`767px`, where: rows stack to one column, definition-list grids collapse, wide tables
become `display: block; overflow-x: auto`, and the status ribbon stacks and drops its
provenance bar. A single secondary breakpoint at `1100px` stacks the cost/quality pair.

### Named Rules

**The One Breakpoint Rule.** Mobile is one decision at 767px, not a cascade of tuned
widths. If a new surface needs a second breakpoint, that is a signal the desktop layout
is doing too much.

## Elevation & Depth

The system is flat by intent, and depth is tonal: the `Deep Slate → Card Slate → Inset
Slate` ladder plus 1px rules carries every layer relationship in the interface. Roughly
thirty surfaces use tone-stepping; exactly two use a shadow. Colour washes
(`color-mix(...)` tints at 6–18%) do the work elsewhere systems reach for elevation.

Shadow is reserved for state and for surfaces that genuinely leave the page.

### Shadow Vocabulary
- **Menu lift** (`box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3)`): a dropdown that floats
  over content.
- **Rewind target** (`box-shadow: 0 0 8px rgba(245, 158, 11, 0.4)`): the stage circle a
  rewind action would hit, on hover. A state response, not ambient decoration.

### Named Rules

**The Flat-At-Rest Rule.** Surfaces are flat at rest. A shadow appears only as a response
— hover, focus, or an overlay escaping its container. A resting card that needs to feel
separate steps one rung down the tonal ladder instead.

## Shapes

Corners are small and role-assigned, not a single global radius: `3px` for a small inline
mark, `4px` for a control or an inset section, `6px` for a card or panel, `10px` for a
badge, `50%` for a status dot. Two asymmetric radii exist and both are meaningful —
`0 4px 4px 0` on a log entry that carries a leading stripe, `1px 1px 0 0` on a chart bar
that rises from a baseline.

Borders are 1px almost everywhere. Widths above that belong to the stripe grammar below.
Dashed borders have exactly two meanings and no others: *this step was skipped*, and
*this position is an estimate, not a measurement*.

### Named Rules

**The Stripe Grammar Rule.** A coloured left edge encodes two things at once. **Width is
the size of the thing:** 4px for a card that is its own row, 3px for a block inside a
card, 2px for an inline mark. **Colour is the state**, from the semantic vocabulary
above. Never invert this — a thicker stripe never means "more important."

**The Radius-By-Role Rule.** Radius names what kind of object something is (mark /
control / card / badge). A new component adopts the radius of the role it plays rather
than picking a new value. Badges are the one rounded family, at 10px; nothing goes fully
pilled (999px).

## Components

### Buttons
- **Shape:** card radius (6px), 1px rule border, `6px 16px` padding, 0.875rem.
- **Default:** inset-slate ground, primary ink. Hover dims to 85% opacity; disabled to
  50% with `not-allowed`.
- **Semantic outlines** (`success` / `warning` / `info` / `error`): border and text take
  the state colour — the info and error variants use their legible text siblings — while
  the ground stays inset slate. A button announces its consequence without shouting.
- **Filled** (`primary`, `confirmed`): green ground with dark ink, reserved for the one
  action that starts or commits work. A confirmed-then-disabled button stays at 90%
  opacity so it still reads as confirmed rather than merely dead.
- **Pending:** 70% opacity, `cursor: wait`, and the label says what is happening
  ("Approving…"), never a spinner alone.
- **Ghost:** transparent, secondary ink, for the least consequential action in a group.

### Badges and pills
Small uppercase words in a 18% tint of their state colour at badge radius (10px). Several
independent families exist (outcome, verdict, severity count, mobile status, section
attention) and each is namespaced to its own surface rather than sharing one base class.
A badge always contains a word — a colour alone is never a badge.

A test run's badge is deliberately neutral chrome, not a state colour: a test is a fact,
not a problem, and it must not borrow the in-flight blue.

### Cards and panels
Two tiers, and the tier says what kind of thing you are looking at.
- **Section** (inset slate, 4px radius, 3px leading stripe, `8px 16px`): a block inside
  a panel. States: neutral, ok, attention.
- **Slot** (card slate, 1px rule, 6px radius, 4px leading stripe, `16px`): a thing that
  is its own row. States: loading, error, empty, ready/ok/attention.

Every panel family duplicates this shell under its own class name rather than sharing
one. That is deliberate: each panel stays independently ownable, and a change to one
cannot silently reshape six others.

### Tables
`border-collapse`, 0.8rem cells in secondary ink, and an uppercase 0.7rem header in
secondary ink over a faint rule. Row states are tints, not weights: flagged and active
rows take an accent-adjacent wash, inert rows drop to muted ink. Prose-carrying tables
(multi-line cells) add a per-row rule; compact key-value tables stay open.

### Inputs
Inset-slate ground, 1px rule, control radius. Focus shifts the **border** to in-flight
blue rather than drawing the global focus ring — native fields get the border treatment,
everything else gets the ring. Validation errors collect in one list in legible red
rather than scattering inline annotations.

### Selectors
Shape itself is semantic here, and two control languages coexist on purpose.
- **Segmented pill** (window, population): picks a **scope** for the numbers. Active
  state is a background and weight change — never colour, because a scope choice is not
  an attention state.
- **Underline tabs** (section switcher): picks a **place**. Active state takes an amber
  underline, the one sanctioned use of the accent for selection.

### Status indicators
A 32px ringed circle per pipeline stage (18px for a nested reviewer), a 2px connector
coloured by the stage it leads into, and 7–8px solid dots for runner, process, and
connection state — all drawing from the same four-colour vocabulary. In-flight states
pulse at 1.5s; a review phase deliberately does not pulse, because it is waiting on a
person rather than working.

### Diff view
A scrolling, capped, wrapped `<pre>` on deep slate. Added lines take success text over a
10% success tint; removed lines take legible red over a 12% error tint; hunk headers
take legible blue; file headers go bold secondary. The tints stay faint on purpose — the
text colour carries the meaning, the tint only groups runs of lines.

### Card glossary
A one-line convention at the foot of a stats card: *In this card, X means Y.* It exists
so each card defines its own jargon once, in the reader's language, instead of five
cards inventing five definitions of the same word.

## Do's and Don'ts

### Do:
- **Do** reserve `#e5a00d` for "a person must act", and reach for a worded badge when
  something merely needs labelling.
- **Do** pair every colour signal with words that say the same thing.
- **Do** write prose in Secondary Ink (`#94a3b8`), and keep Muted Ink for timestamps and
  inert marks.
- **Do** step down the tonal ladder to separate a resting surface; save shadow for hover,
  focus, and things that float.
- **Do** follow the stripe grammar exactly: width for size-of-thing, colour for state.
- **Do** render loading, empty, error, and "not recorded" as designed states with
  sentences — never a blank panel or a silently stale number.
- **Do** name the thing in every user-facing string ("the team disputed the finding"),
  never the database field or enum value.
- **Do** give a new panel family its own class namespace, even if its shell is identical
  to an existing one.
- **Do** check contrast against the AA 4.5:1 bar and record the measured ratio in a
  comment when a choice is close.

### Don't:
- **Don't** introduce a web font. Both stacks are the operator's own system fonts, and
  that is the choice.
- **Don't** add gradients, glass, blur, or ambient glow. The two shadows and one gradient
  in this system are each functional and specific.
- **Don't** use a fully-pilled radius (999px) for anything; badges round to 10px and
  everything else sits at 3-6px by role.
- **Don't** grow a metric to hero size to make it matter. Put it first and explain it.
- **Don't** dress a scope control and a navigation control the same way; the shape is
  carrying meaning.
- **Don't** use raw `rgba()` for a state tint when the token exists —
  `color-mix(in srgb, var(--color-X) N%, transparent)` is the house idiom.
- **Don't** use dashed borders for decoration; they mean skipped or estimated.
- **Don't** let a colour convey a fact that no text repeats.
