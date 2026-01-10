'use strict';

/**
 * claudescreenfix-hardwicksoftware - stops the scroll glitch from cooking your terminal
 *
 * the problem:
 *   claude code uses ink (react for terminals) and it doesn't clear scrollback
 *   so after like 30 min your terminal's got thousands of lines in the buffer
 *   every re-render touches ALL of em - O(n) where n keeps growing
 *   resize events fire with no debounce so tmux/screen users get cooked
 *
 * what we do:
 *   - hook stdout.write to inject scrollback clears periodically
 *   - debounce SIGWINCH so resize ain't thrashing
 *   - enhance /clear to actually clear scrollback not just the screen
 *
 * v1.0.1: fixed the typing bug where keystrokes got eaten
 *   - stdin echoes now pass through untouched
 *   - clears happen async so typing isn't interrupted
 *
 * v2.0.0: added glitch detection + 120 line limit
 *   - actually detects when terminal's fucked instead of just clearing blindly
 *   - caps output at 120 lines so buffer won't explode
 *   - can force send enter key to break out of frozen state
 */

const CLEAR_SCROLLBACK = '\x1b[3J';
const CURSOR_SAVE = '\x1b[s';
const CURSOR_RESTORE = '\x1b[u';
const CLEAR_SCREEN = '\x1b[2J';
const HOME_CURSOR = '\x1b[H';

// Try to load glitch detector (optional dependency)
let GlitchDetector = null;
let glitchDetector = null;
try {
  const detector = require('./glitch-detector.cjs');
  GlitchDetector = detector.GlitchDetector;
  glitchDetector = detector.getDetector();
} catch (e) {
  // Glitch detector not available, continue without it
}

// config - tweak these if needed
const config = {
  resizeDebounceMs: 150,        // how long to wait before firing resize
  periodicClearMs: 60000,       // clear scrollback every 60s
  clearAfterRenders: 500,       // or after 500 render cycles
  typingCooldownMs: 500,        // wait this long after typing to clear
  maxLineCount: 120,            // NEW: max terminal lines before forced trim
  glitchRecoveryEnabled: true,  // NEW: enable automatic glitch recovery
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
let lineCount = 0;                // NEW: track output line count for 120-line limit
let glitchRecoveryInProgress = false;  // NEW: prevent recovery loops

function log(...args) {
  if (config.debug) {
    process.stderr.write('[terminal-fix] ' + args.join(' ') + '\n');
  }
}

/**
 * check if user's actively typing (within cooldown window)
 */
function isTypingActive() {
  return (Date.now() - lastTypingTime) < config.typingCooldownMs;
}

/**
 * detect if this looks like a stdin echo (single printable char or short sequence)
 * stdin echoes are typically: single chars, backspace seqs, arrow key echoes
 * we don't wanna mess with these or typing gets wonky
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
 * safe clear - defers if typing's active so we don't eat keystrokes
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
 * call this once at startup, calling again won't do anything
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

      // track output for glitch detection
      if (glitchDetector) {
        glitchDetector.trackStdout();
      }

      // count lines so we can cap at 120
      const newlineCount = (chunk.match(/\n/g) || []).length;
      lineCount += newlineCount;

      // hit the limit? force a trim
      if (lineCount > config.maxLineCount) {
        log('line limit exceeded (' + lineCount + '/' + config.maxLineCount + '), forcing trim');
        lineCount = 0;
        chunk = CURSOR_SAVE + CLEAR_SCROLLBACK + CURSOR_RESTORE + chunk;
      }

      // ink clears screen before re-render, we piggyback on that
      // but only if not actively typing
      if (chunk.includes(CLEAR_SCREEN) || chunk.includes(HOME_CURSOR)) {
        lineCount = 0;  // Reset line count on screen clear
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

      // /clear should actually clear everything (it's user-requested so do it now)
      if (chunk.includes('Conversation cleared') || chunk.includes('Chat cleared')) {
        log('/clear detected, nuking scrollback');
        lineCount = 0;
        chunk = CLEAR_SCROLLBACK + chunk;
      }

      // glitched? try to recover
      if (glitchDetector && config.glitchRecoveryEnabled && !glitchRecoveryInProgress) {
        if (glitchDetector.isInGlitchState()) {
          glitchRecoveryInProgress = true;
          log('GLITCH DETECTED - initiating recovery');

          // Force clear scrollback immediately
          chunk = CURSOR_SAVE + CLEAR_SCROLLBACK + CURSOR_RESTORE + chunk;
          lineCount = 0;
          renderCount = 0;

          // Attempt full recovery asynchronously
          setImmediate(async () => {
            try {
              await glitchDetector.attemptRecovery();
            } catch (e) {
              log('recovery error:', e.message);
            }
            glitchRecoveryInProgress = false;
          });
        }
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

  // hook up the glitch detector
  if (glitchDetector) {
    glitchDetector.install();

    // Listen for glitch events
    glitchDetector.on('glitch-detected', (data) => {
      log('GLITCH EVENT:', JSON.stringify(data.signals));
    });

    glitchDetector.on('recovery-success', (data) => {
      log('recovery successful via', data.method);
    });

    glitchDetector.on('recovery-failed', () => {
      log('recovery failed - may need manual intervention');
    });

    log('glitch detector installed');
  }

  installed = true;
  log('installed successfully - v2.0.0 with glitch detection & 120-line limit');
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
 * manually clear scrollback - call this whenever you want, it won't break anything
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
  const stats = {
    renderCount,
    lineCount,
    lastResizeTime,
    installed,
    config
  };

  // add glitch stats if available
  if (glitchDetector) {
    stats.glitch = glitchDetector.getMetrics();
  }

  return stats;
}

/**
 * force recovery if shit hits the fan
 */
async function forceRecovery() {
  if (glitchDetector) {
    log('forcing recovery manually');
    return await glitchDetector.attemptRecovery();
  }
  // Fallback if no detector
  clearScrollback();
  return true;
}

/**
 * check if terminal's currently cooked
 */
function isGlitched() {
  return glitchDetector ? glitchDetector.isInGlitchState() : false;
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
 * disable the fix (it's mostly for testing)
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
  config,
  // NEW v2.0 exports
  forceRecovery,
  isGlitched,
  getDetector: () => glitchDetector
};
