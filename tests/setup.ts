// tests/setup.ts
// Bun auto-loads .env from the project root — no dotenv library needed.
// This file exists as a --preload hook for any future global test setup.

// The Claude Agent SDK refuses to spawn a subprocess inside an existing Claude
// Code session (detects the CLAUDECODE env var). Unset it so integration tests
// that call query() can run from within Claude Code.
delete process.env.CLAUDECODE;
