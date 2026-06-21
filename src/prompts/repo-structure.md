# Repository Structure

The target extension repository layout varies by product. Key directories:

- **Source directory** — Production AL source code (codeunits, tables, pages, etc.)
- **Test directory** — Test AL source code
- Other directories may include Permissions, Install, Upgrade, Translations, DemoApp, OnPrem

**Critical:** The session root contains multiple extension repos. Each is a separate git repo. All git commands must run from within the correct repo subdirectory.

Companion repos (read-only references) may include: BC (the Business Central base app) plus any product-specific dependency apps declared in your repo registration — depending on the product.
