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
  debug: process.env.CLAUDE_TERMINAL_FIX_DEBUG === '1',
  disabled: process.env.CLAUDE_TERMINAL_FIX_DISABLED === '1'
};

// state tracking
let renderCount = 0;
let lastResizeTime = 0;
let resizeTimeout = null;
let originalWrite = null;
let installed = false;

function log(...args) {
  if (config.debug) {
    process.stderr.write('[terminal-fix] ' + args.join(' ') + '\n');
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

  // hook stdout.write - this is where the magic happens
  process.stdout.write = function(chunk, encoding, callback) {
    if (typeof chunk === 'string') {
      renderCount++;

      // ink clears screen before re-render, we piggyback on that
      if (chunk.includes(CLEAR_SCREEN) || chunk.includes(HOME_CURSOR)) {
        if (config.clearAfterRenders > 0 && renderCount >= config.clearAfterRenders) {
          log('clearing scrollback after ' + renderCount + ' renders');
          renderCount = 0;
          chunk = CLEAR_SCROLLBACK + chunk;
        }
      }

      // /clear command should actually clear everything
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
  if (config.periodicClearMs > 0) {
    setInterval(() => {
      if (process.stdout.isTTY) {
        log('periodic scrollback clear');
        originalWrite(CURSOR_SAVE + CLEAR_SCROLLBACK + CURSOR_RESTORE);
      }
    }, config.periodicClearMs);
  }

  installed = true;
  log('installed successfully');
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
