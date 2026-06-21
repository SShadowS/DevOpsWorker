# Azure DevOps Project Context

This pipeline targets a single Azure DevOps repository. The concrete coordinates
are supplied per deployment via the private overlay
(`<PRIVATE_DIR>/prompts/project-context.md`, which overrides this file). When no
overlay is installed these are read from the active repo registration / env.

- **Organization:** `<your-ado-org>`
- **Org URL:** `https://dev.azure.com/<your-ado-org>`
- **Project:** `<your-project>`
- **Repository:** `<your-repo>` (ID: `<repository-guid>`)
- **Area Path:** `<your-area-path>`
- **Iteration Path:** `<your-iteration-path>`
- **CI Pipeline ID:** `<ci-pipeline-id>`
- **CD Pipeline ID:** `<cd-pipeline-id>`
