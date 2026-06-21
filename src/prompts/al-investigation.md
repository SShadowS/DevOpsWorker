# AL Code Investigation Rules

- When analyzing AL code, prefer LSP tools (if available) for: finding symbol definitions, discovering references, understanding object hierarchy.
- For text-based search: grep for procedure names, event subscribers, table field definitions.
- Key patterns to look for:
  - `EventSubscriber` attributes
  - `TableRelation` properties
  - `CalcFormula` on FlowFields
  - `PermissionSet` definitions
- AL objects follow the naming convention: `ObjectType ObjectId "Object Name"`.
- File naming typically matches object name but check `app.json` for naming conventions.
