# Generates a PDF from docs/project-overview.md (with Mermaid diagram rendering).
# Uses mermaid-cli to pre-render diagrams, then md-to-pdf for the final PDF.
# Requires: npx (comes with Node/Bun). Chromium downloaded automatically on first run.
#
# Usage:
#   pwsh docs/generate-pdf.ps1                        # output: docs/project-overview.pdf
#   pwsh docs/generate-pdf.ps1 my-output.pdf          # output: my-output.pdf

param(
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Input_ = Join-Path $ScriptDir 'project-overview.md'
if (-not $OutputPath) { $OutputPath = Join-Path $ScriptDir 'project-overview.pdf' }
$TmpDir = Join-Path $ScriptDir '.pdf-tmp'

if (-not (Test-Path $Input_)) {
    Write-Error "Error: $Input_ not found"
    exit 1
}

try {
    if (Test-Path $TmpDir) { Remove-Item -Recurse -Force $TmpDir }
    New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null

    # Step 1: Pre-render Mermaid diagrams -> replaces ```mermaid blocks with image refs
    Write-Host '[1/3] Rendering Mermaid diagrams ...'
    npx --yes @mermaid-js/mermaid-cli -i $Input_ -o (Join-Path $TmpDir 'processed.md') -e svg --quiet
    if ($LASTEXITCODE -ne 0) { throw 'mermaid-cli failed' }

    # Step 2: Replace markdown image refs with HTML <img> tags that have constrained height
    Write-Host '[2/3] Constraining diagram sizes ...'
    $ProcessedMd = Join-Path $TmpDir 'processed.md'
    $Content = Get-Content -Raw $ProcessedMd
    $Content = $Content -replace '!\[diagram\]\(([^)]*\.svg)\)', '<img src="$1" style="max-height:700px;width:auto;display:block;margin:1em auto;">'
    Set-Content -Path $ProcessedMd -Value $Content -NoNewline

    # Step 3: Convert processed markdown (with SVG images) to PDF
    Write-Host '[3/3] Converting to PDF ...'
    npx --yes md-to-pdf $ProcessedMd --config-file (Join-Path $ScriptDir 'pdf.config.js')
    if ($LASTEXITCODE -ne 0) { throw 'md-to-pdf failed' }

    Move-Item -Force (Join-Path $TmpDir 'processed.pdf') $OutputPath

    Write-Host "Done: $OutputPath"
}
finally {
    if (Test-Path $TmpDir) { Remove-Item -Recurse -Force $TmpDir }
}
