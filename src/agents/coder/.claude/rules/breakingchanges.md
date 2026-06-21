# Breaking Changes in AL for Business Central

Breaking changes are modifications that can cause dependent extensions to fail compilation or runtime errors. This document serves as a reference when making code changes.

---

## Object-Level Breaking Changes

| Change | Impact |
|--------|--------|
| Deleting an object (table, page, codeunit, etc.) | Dependents can't reference it |
| Renaming an object | References break |
| Changing object ID | References break |
| Changing object type | Complete break |

---

## Table Breaking Changes

| Change | Impact |
|--------|--------|
| Deleting a field | Data loss, reference breaks |
| Renaming a field | References break |
| Changing field ID | References break |
| Changing field data type | Data conversion issues |
| Reducing field length (e.g., Text[100] → Text[50]) | Data truncation |
| Removing table relation | Lookup breaks |
| Changing primary key fields | Major data issues |

---

## Page Breaking Changes

| Change | Impact |
|--------|--------|
| Deleting controls/actions | Extensions targeting them break |
| Renaming controls/actions | Extensions can't find them |
| Changing control type | Extension modifications fail |
| Removing page parts | SubPageLink references break |

---

## Procedure/Function Breaking Changes

| Change | Impact |
|--------|--------|
| Deleting a public procedure | Callers break |
| Renaming a public procedure | Callers break |
| Changing parameter types | Callers break |
| Changing parameter order | Callers break |
| Removing parameters | Callers break |
| Changing return type | Callers break |
| Changing from public to local/internal | External callers break |

---

## Enum Breaking Changes

| Change | Impact |
|--------|--------|
| Deleting enum values | Code using them breaks |
| Changing enum value IDs | Data corruption |
| Renaming enum values | References break |

---

## Non-Breaking Changes (Safe)

| Change | Why Safe |
|--------|----------|
| Adding new fields | Existing code unaffected |
| Adding new procedures | Existing code unaffected |
| Adding new parameters with default values | Backward compatible |
| Increasing field length (Text[50] → Text[100]) | No data loss |
| Adding new enum values | Existing values work |
| Changing captions/tooltips | No code impact |
| Adding new objects | No dependencies yet |
| Changing field/control visibility | Usually safe |
| Renaming local procedures | Not externally visible |

---

## AppSource Cop Rules

For AppSource apps, the compiler enforces breaking change rules via `AppSourceCop`:

| Rule | Description |
|------|-------------|
| AS0011 | Field ID changes |
| AS0012 | Field type changes |
| AS0013 | Field length reduction |
| AS0014 | Public procedure signature changes |
| AS0015 | Object removal |
| AS0016 | Key changes |

---

## Guidelines for UI Simplification Changes

When making UI changes, the following are **safe**:
- Caption changes
- Tooltip changes
- Adding fields/procedures
- Renaming control names (not IDs) for internal pages
- Reorganizing page layout
- Changing field visibility
- Adding new actions

The following require **caution**:
- Renaming controls on pages that partners may extend
- Removing controls/actions that partners may reference
- Changing page parts or SubPageLinks
