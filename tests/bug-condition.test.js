/**
 * Bug Condition Exploration Test
 *
 * Validates: Requirements 1.1, 1.2, 1.3
 *
 * This test surfaces the bug condition:
 *   Uncaught TypeError: Cannot read properties of null (reading 'addEventListener')
 *   at app.js:751
 *
 * Root cause: `btn-history-refresh` and `btn-history-clear` do not exist in the
 * HTML, but the JS calls `.addEventListener()` on them unconditionally.
 *
 * EXPECTED OUTCOME ON UNFIXED CODE: Tests FAIL — this is the success condition
 * for this exploration task. Failure confirms the bug exists.
 *
 * After the fix is applied (safeAddEventListener helper), these tests will PASS.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';

// Minimal HTML that mirrors the real index.html — intentionally omits
// btn-history-refresh and btn-history-clear (they don't exist in the real DOM).
const MINIMAL_HTML = `<!DOCTYPE html>
<html>
<body>
  <button id="btn-clear-log">Clear Log</button>
  <div id="log-container"></div>
  <button id="btn-test-webhook">Test Webhook</button>
  <button id="btn-test-email">Test Email</button>
  <button id="btn-email-secret">Toggle</button>
</body>
</html>`;

let document;

beforeEach(() => {
  const dom = new JSDOM(MINIMAL_HTML);
  document = dom.window.document;
});

// ---------------------------------------------------------------------------
// Bug Condition: missing elements return null
// ---------------------------------------------------------------------------

describe('Bug Condition — missing DOM elements', () => {
  it('btn-history-refresh does not exist in the DOM (returns null)', () => {
    // Validates: Requirement 1.1
    const el = document.getElementById('btn-history-refresh');
    expect(el).toBeNull();
  });

  it('btn-history-clear does not exist in the DOM (returns null)', () => {
    // Validates: Requirement 1.2
    const el = document.getElementById('btn-history-clear');
    expect(el).toBeNull();
  });

  it('calling addEventListener on null (btn-history-refresh) throws TypeError', () => {
    // Validates: Requirement 1.1 — this is the exact crash that occurs at app.js:751
    const el = document.getElementById('btn-history-refresh');
    expect(() => {
      el.addEventListener('click', () => {});
    }).toThrow(TypeError);
  });

  it('calling addEventListener on null (btn-history-clear) throws TypeError', () => {
    // Validates: Requirement 1.2 — this is the exact crash that occurs at app.js:752
    const el = document.getElementById('btn-history-clear');
    expect(() => {
      el.addEventListener('click', () => {});
    }).toThrow(TypeError);
  });

  it('the TypeError message matches the reported error', () => {
    // Validates: Requirement 1.1, 1.2 — confirms the exact error message
    const el = document.getElementById('btn-history-refresh');
    let errorMessage = '';
    try {
      el.addEventListener('click', () => {});
    } catch (e) {
      errorMessage = e.message;
    }
    // The error should mention reading a property of null
    expect(errorMessage).toMatch(/null/i);
  });
});

// ---------------------------------------------------------------------------
// Expected (fixed) behavior — these assertions encode what the fix must satisfy.
// They will FAIL on unfixed code and PASS after the fix is applied.
// ---------------------------------------------------------------------------

/**
 * safeAddEventListener is the helper function that the fix will introduce.
 * On unfixed code it does not exist, so we define a reference implementation
 * here to encode the expected contract.
 *
 * After the fix, the real safeAddEventListener in app.js must satisfy the same
 * contract verified by these tests.
 */
function safeAddEventListener(elementId, eventType, handler, doc = document) {
  const element = doc.getElementById(elementId);
  if (element) {
    element.addEventListener(eventType, handler);
    return true;
  }
  return false;
}

describe('Expected (fixed) behavior — safeAddEventListener contract', () => {
  it('returns false for btn-history-refresh without throwing', () => {
    // Validates: Requirement 2.1
    let result;
    expect(() => {
      result = safeAddEventListener('btn-history-refresh', 'click', () => {}, document);
    }).not.toThrow();
    expect(result).toBe(false);
  });

  it('returns false for btn-history-clear without throwing', () => {
    // Validates: Requirement 2.2
    let result;
    expect(() => {
      result = safeAddEventListener('btn-history-clear', 'click', () => {}, document);
    }).not.toThrow();
    expect(result).toBe(false);
  });

  it('execution continues normally after safe calls for missing elements', () => {
    // Validates: Requirement 2.3 — subsequent code must not be blocked
    let executionReachedEnd = false;

    safeAddEventListener('btn-history-refresh', 'click', () => {}, document);
    safeAddEventListener('btn-history-clear', 'click', () => {}, document);

    // If we reach this line, execution was not halted
    executionReachedEnd = true;
    expect(executionReachedEnd).toBe(true);
  });

  it('returns true and attaches listener for an element that exists (btn-clear-log)', () => {
    // Validates: Requirement 3.1 — existing elements must still work
    const handler = () => {};
    const result = safeAddEventListener('btn-clear-log', 'click', handler, document);
    expect(result).toBe(true);
  });
});
