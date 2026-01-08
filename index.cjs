'use strict';

/**
 * claudescreenfix-hardwicksoftware - stops the scroll glitch from cooking your terminal
 *
 * the problem:
 *   claude code uses ink (react for terminals) and it dont clear scrollback
 *   so after like 30 min your terminal got thousands of lines in the buffer
 *   every re-render touches ALL of em - O(n) where n keeps growing
 *   resize events fire with no debounce so tmux/screen users get cooked
 *
 * what we do:
 *   - hook stdout.write to inject scrollback clears periodically
 *   - debounce SIGWINCH so resize aint thrashing
 *   - enhance /clear to actually clear scrollback not just the screen
 *
 * FIXED v1.0.1: typing issue where stdin echo was being intercepted
 *   - now detects stdin echo writes and passes them through unmodified
 *   - uses setImmediate for periodic clears to not interrupt typing
 *   - tracks "active typing" window to defer clears during input
 */

const CLEAR_SCROLLBACK = '\x1b[3J';
const CURSOR_SAVE = '\x1b[s';
const CURSOR_RESTORE = '\x1b[u';
const CLEAR_SCREEN = '\x1b[2J';
const HOME_CURSOR = '\x1b[H';

// config - tweak these if needed
const config = {
  resizeDebounceMs: 150,        // how long to wait before firing resize
  periodicClearMs: 60000,       // clear scrollback every 60s
  clearAfterRenders: 500,       // or after 500 render cycles
  typingCooldownMs: 500,        // wait this long after typing to clear
  debug: process.env.CLAUDE_TERMINAL_FIX_DEBUG === '1',
  disabled: process.env.CLAUDE_TERMINAL_FIX_DISABLED === '1'
};

// state tracking
let renderCount = 0;
let lastResizeTime = 0;
let resizeTimeout = null;
let originalWrite = null;
let installed = false;
let lastTypingTime = 0;           // track when user last typed
let pendingClear = false;         // defer clear if typing active
let clearIntervalId = null;

function log(...args) {
  if (config.debug) {
    process.stderr.write('[terminal-fix] ' + args.join(' ') + '\n');
  }
}

/**
 * check if user is actively typing (within cooldown window)
 */
function isTypingActive() {
  return (Date.now() - lastTypingTime) < config.typingCooldownMs;
}

/**
 * detect if this looks like a stdin echo (single printable char or short sequence)
 * stdin echoes are typically: single chars, backspace sequences, arrow key echoes
 */
function isStdinEcho(chunk) {
  // single printable character (including space)
  if (chunk.length === 1 && chunk.charCodeAt(0) >= 32 && chunk.charCodeAt(0) <= 126) {
    return true;
  }
  // backspace/delete echo (usually 1-3 chars with control codes)
  if (chunk.length <= 4 && (chunk.includes('\b') || chunk.includes('\x7f'))) {
    return true;
  }
  // arrow key echo or cursor movement (short escape sequences)
  if (chunk.length <= 6 && chunk.startsWith('\x1b[') && !chunk.includes('J') && !chunk.includes('H')) {
    return true;
  }
  // enter/newline
  if (chunk === '\n' || chunk === '\r' || chunk === '\r\n') {
    return true;
  }
  return false;
}

/**
 * safe clear - defers if typing active
 */
function safeClearScrollback() {
  if (isTypingActive()) {
    if (!pendingClear) {
      pendingClear = true;
      log('deferring clear - typing active');
      setTimeout(() => {
        pendingClear = false;
        if (!isTypingActive()) {
          safeClearScrollback();
        }
      }, config.typingCooldownMs);
    }
    return;
  }

  if (originalWrite && process.stdout.isTTY) {
    // use setImmediate to not block the event loop
    setImmediate(() => {
      log('executing deferred scrollback clear');
      originalWrite(CURSOR_SAVE + CLEAR_SCROLLBACK + CURSOR_RESTORE);
    });
  }
}

/**
 * installs the fix - hooks into stdout and sigwinch
 * call this once at startup, calling again is a no-op
 */
function install() {
  if (installed || config.disabled) {
    if (config.disabled) log('disabled via env var');
    return;
  }

  originalWrite = process.stdout.write.bind(process.stdout);

  // track stdin to know when user is typing
  if (process.stdin.isTTY) {
    process.stdin.on('data', () => {
      lastTypingTime = Date.now();
    });
  }

  // hook stdout.write - this is where the magic happens
  process.stdout.write = function(chunk, encoding, callback) {
    // CRITICAL FIX: pass stdin echoes through unmodified
    // this prevents the typing issue where keystrokes get lost
    if (typeof chunk === 'string') {
      // check if this is a stdin echo - if so, pass through immediately
      if (isStdinEcho(chunk)) {
        lastTypingTime = Date.now();  // update typing time
        return originalWrite(chunk, encoding, callback);
      }

      renderCount++;

      // ink clears screen before re-render, we piggyback on that
      // but only if not actively typing
      if (chunk.includes(CLEAR_SCREEN) || chunk.includes(HOME_CURSOR)) {
        if (config.clearAfterRenders > 0 && renderCount >= config.clearAfterRenders) {
          if (!isTypingActive()) {
            log('clearing scrollback after ' + renderCount + ' renders');
            renderCount = 0;
            chunk = CLEAR_SCROLLBACK + chunk;
          } else {
            log('skipping render-based clear - typing active');
          }
        }
      }

      // /clear command should actually clear everything (immediate, user-requested)
      if (chunk.includes('Conversation cleared') || chunk.includes('Chat cleared')) {
        log('/clear detected, nuking scrollback');
        chunk = CLEAR_SCROLLBACK + chunk;
      }
    }

    return originalWrite(chunk, encoding, callback);
  };

  // debounce resize events - tmux users know the pain
  installResizeDebounce();

  // periodic cleanup so long sessions dont get cooked
  // uses safeClearScrollback which respects typing activity
  if (config.periodicClearMs > 0) {
    clearIntervalId = setInterval(() => {
      log('periodic clear check');
      safeClearScrollback();
    }, config.periodicClearMs);
  }

  installed = true;
  log('installed successfully - v1.0.1 with typing fix');
}

function installResizeDebounce() {
  const originalOn = process.on.bind(process);
  let sigwinchHandlers = [];

  function debouncedSigwinch() {
    const now = Date.now();
    const timeSince = now - lastResizeTime;
    lastResizeTime = now;

    if (resizeTimeout) clearTimeout(resizeTimeout);

    // if events coming too fast, batch em
    if (timeSince < config.resizeDebounceMs) {
      resizeTimeout = setTimeout(() => {
        log('firing debounced resize');
        sigwinchHandlers.forEach(h => { try { h(); } catch(e) {} });
      }, config.resizeDebounceMs);
    } else {
      sigwinchHandlers.forEach(h => { try { h(); } catch(e) {} });
    }
  }

  process.on = function(event, handler) {
    if (event === 'SIGWINCH') {
      sigwinchHandlers.push(handler);
      if (sigwinchHandlers.length === 1) {
        originalOn('SIGWINCH', debouncedSigwinch);
      }
      return this;
    }
    return originalOn(event, handler);
  };

  log('resize debounce installed');
}

/**
 * manually clear scrollback - call this whenever you want
 */
function clearScrollback() {
  if (originalWrite) {
    originalWrite(CLEAR_SCROLLBACK);
  } else {
    process.stdout.write(CLEAR_SCROLLBACK);
  }
  log('manual scrollback clear');
}

/**
 * get current stats for debugging
 */
function getStats() {
  return {
    renderCount,
    lastResizeTime,
    installed,
    config
  };
}

/**
 * update config at runtime
 */
function setConfig(key, value) {
  if (key in config) {
    config[key] = value;
    log('config updated: ' + key + ' = ' + value);
  }
}

/**
 * disable the fix (mostly for testing)
 */
function disable() {
  if (originalWrite) {
    process.stdout.write = originalWrite;
    log('disabled');
  }
}

module.exports = {
  install,
  clearScrollback,
  getStats,
  setConfig,
  disable,
  config
};
