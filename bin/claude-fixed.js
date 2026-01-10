#!/usr/bin/env node
'use strict';

/**
 * PTY wrapper for Claude Code terminal fix
 *
 * Since Claude's binary is a Node.js SEA (ELF), we can't inject via --import.
 * Instead, we spawn claude in a pseudo-terminal and intercept stdout to inject
 * scrollback clears and handle SIGWINCH debouncing.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Terminal escape codes
const CLEAR_SCROLLBACK = '\x1b[3J';
const CURSOR_SAVE = '\x1b[s';
const CURSOR_RESTORE = '\x1b[u';
const CLEAR_SCREEN = '\x1b[2J';
const HOME_CURSOR = '\x1b[H';

// Config
const config = {
  resizeDebounceMs: 150,
  periodicClearMs: 60000,
  clearAfterRenders: 500,
  typingCooldownMs: 500,
  maxLineCount: 120,
  debug: process.env.CLAUDE_TERMINAL_FIX_DEBUG === '1',
  disabled: process.env.CLAUDE_TERMINAL_FIX_DISABLED === '1'
};

// State
let renderCount = 0;
let lineCount = 0;
let lastTypingTime = 0;
let lastResizeTime = 0;
let resizeTimeout = null;

function log(...args) {
  if (config.debug) {
    process.stderr.write('[terminal-fix] ' + args.join(' ') + '\n');
  }
}

function isTypingActive() {
  return (Date.now() - lastTypingTime) < config.typingCooldownMs;
}

// Find the claude binary
function findClaude() {
  const possiblePaths = [
    path.join(process.env.HOME || '', '.local/bin/claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude'
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // Try which
  try {
    const { execSync } = require('child_process');
    return execSync('which claude', { encoding: 'utf8' }).trim();
  } catch (e) {
    return null;
  }
}

// Process output chunk, injecting clears as needed
function processOutput(chunk) {
  if (config.disabled) return chunk;

  let output = chunk;
  const str = chunk.toString();

  renderCount++;

  // Count newlines
  const newlines = (str.match(/\n/g) || []).length;
  lineCount += newlines;

  // Line limit exceeded - force clear
  if (lineCount > config.maxLineCount) {
    log('line limit exceeded (' + lineCount + '), forcing clear');
    lineCount = 0;
    output = CURSOR_SAVE + CLEAR_SCROLLBACK + CURSOR_RESTORE + output;
  }

  // Screen clear detected - piggyback our scrollback clear
  if (str.includes(CLEAR_SCREEN) || str.includes(HOME_CURSOR)) {
    lineCount = 0;
    if (config.clearAfterRenders > 0 && renderCount >= config.clearAfterRenders) {
      if (!isTypingActive()) {
        log('clearing after ' + renderCount + ' renders');
        renderCount = 0;
        output = CLEAR_SCROLLBACK + output;
      }
    }
  }

  // /clear command - nuke everything
  if (str.includes('Conversation cleared') || str.includes('Chat cleared')) {
    log('/clear detected');
    lineCount = 0;
    output = CLEAR_SCROLLBACK + output;
  }

  return output;
}

// Main
async function main() {
  if (config.disabled) {
    log('disabled via env');
  }

  const claudePath = findClaude();
  if (!claudePath) {
    console.error('claude not found in PATH');
    process.exit(1);
  }

  log('using claude at: ' + claudePath);
  log('fix enabled, config:', JSON.stringify(config));

  // Try to use node-pty for proper PTY support
  let pty;
  try {
    pty = require('node-pty');
  } catch (e) {
    // Fall back to basic spawn with pipe
    log('node-pty not available, using basic spawn');
    pty = null;
  }

  if (pty && process.stdin.isTTY) {
    // PTY mode - full terminal emulation
    const term = pty.spawn(claudePath, process.argv.slice(2), {
      name: process.env.TERM || 'xterm-256color',
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      cwd: process.cwd(),
      env: process.env
    });

    // Handle resize with debounce
    process.stdout.on('resize', () => {
      const now = Date.now();
      if (resizeTimeout) clearTimeout(resizeTimeout);

      if (now - lastResizeTime < config.resizeDebounceMs) {
        resizeTimeout = setTimeout(() => {
          log('debounced resize');
          term.resize(process.stdout.columns, process.stdout.rows);
        }, config.resizeDebounceMs);
      } else {
        term.resize(process.stdout.columns, process.stdout.rows);
      }
      lastResizeTime = now;
    });

    // Track typing
    process.stdin.on('data', (data) => {
      lastTypingTime = Date.now();
      term.write(data);
    });

    // Process output
    term.onData((data) => {
      const processed = processOutput(data);
      process.stdout.write(processed);
    });

    term.onExit(({ exitCode }) => {
      process.exit(exitCode);
    });

    // Raw mode for proper terminal handling
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    // Periodic clear
    if (config.periodicClearMs > 0) {
      setInterval(() => {
        if (!isTypingActive()) {
          log('periodic clear');
          process.stdout.write(CURSOR_SAVE + CLEAR_SCROLLBACK + CURSOR_RESTORE);
        }
      }, config.periodicClearMs);
    }

  } else {
    // Basic mode - just spawn and pipe (limited fix capability)
    log('basic mode (no PTY)');

    const child = spawn(claudePath, process.argv.slice(2), {
      stdio: ['inherit', 'pipe', 'inherit'],
      env: process.env
    });

    child.stdout.on('data', (data) => {
      const processed = processOutput(data);
      process.stdout.write(processed);
    });

    child.on('exit', (code) => {
      process.exit(code || 0);
    });

    // Track typing via stdin
    process.stdin.on('data', () => {
      lastTypingTime = Date.now();
    });
  }
}

main().catch(err => {
  console.error('terminal fix error:', err.message);
  process.exit(1);
});
