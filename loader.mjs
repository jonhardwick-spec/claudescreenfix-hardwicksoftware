/**
 * ESM loader for --import usage (DEPRECATED)
 *
 * This approach doesn't work with Claude Code because:
 * - The binary at ~/.local/bin/claude is a Node.js SEA (Single Executable Application)
 * - It's compiled ELF that embeds the JS, so we can't inject via --import
 *
 * Use bin/claude-fixed.js instead - it's a PTY wrapper that intercepts output.
 *
 * Usage: claude-fixed [args]
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// load the fix (it's commonjs so we need require)
const fix = require('./index.cjs');

// install immediately
fix.install();

console.error('[terminal-fix] Warning: ESM loader approach is deprecated.');
console.error('[terminal-fix] Use "claude-fixed" command instead.');
