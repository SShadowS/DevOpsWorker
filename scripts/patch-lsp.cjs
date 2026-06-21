// Patch CLI's LSP isEnabled() to return true during "pending"/"not-started" states.
// Fixes race condition where LSP tool is excluded from the tool list because
// LSP init is async but isEnabled() is called synchronously at startup.
// See: https://github.com/anthropics/claude-agent-sdk-typescript/issues/123#issuecomment-3943430677
//
// Safe because the LSP tool's call() method already awaits init completion.
// Re-run automatically via postinstall after every `bun install`.

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js');

if (!fs.existsSync(file)) {
  console.log('patch-lsp: cli.js not found, skipping (SDK not installed yet)');
  process.exit(0);
}

let code = fs.readFileSync(file, 'utf8');

// Match the LSP isEnabled pattern regardless of minified variable names.
// Structure: isEnabled(){if(<statusFn>().status==="failed")return!1;let <v>=<mgrFn>();if(!<v>)return!1;let <s>=<v>.getAllServers();if(<s>.size===0)return!1;return Array.from(<s>.values()).some((<z>)=><z>.state!=="error")}
const pattern = /isEnabled\(\)\{if\((\w+)\(\)\.status==="failed"\)return!1;let (\w+)=(\w+)\(\);if\(!\2\)return!1;let (\w+)=\2\.getAllServers\(\);if\(\4\.size===0\)return!1;return Array\.from\(\4\.values\(\)\)\.some\(\((\w+)\)=>\5\.state!=="error"\)\}/;

const match = code.match(pattern);
if (!match) {
  // Check if already patched
  if (code.includes('||XY6().status==="pending")return!0') ||
      code.includes('status==="pending")return!0;let')) {
    console.log('patch-lsp: already patched, skipping');
    process.exit(0);
  }
  console.error('patch-lsp: ERROR — isEnabled pattern not found. Minification may have changed significantly.');
  process.exit(1);
}

const [original, statusFn, v, mgrFn, s, z] = match;

// Insert early return for "not-started" and "pending" after the "failed" check.
const patched = `isEnabled(){if(${statusFn}().status==="failed")return!1;if(${statusFn}().status==="not-started"||${statusFn}().status==="pending")return!0;let ${v}=${mgrFn}();if(!${v})return!1;let ${s}=${v}.getAllServers();if(${s}.size===0)return!1;return Array.from(${s}.values()).some((${z})=>${z}.state!=="error")}`;

code = code.replace(original, patched);
fs.writeFileSync(file, code);
console.log('patch-lsp: patched LSP isEnabled() successfully');
