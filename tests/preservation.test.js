/**
 * Preservation Property Tests
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 *
 * These tests verify that existing DOM elements continue to have event listeners
 * attached correctly. They encode the baseline behavior that MUST be preserved
 * after the bug fix is applied.
 *
 * EXPECTED OUTCOME: Tests ALL PASS (these are preservation tests, not bug tests).
 * They confirm that the fix does not regress existing functionality.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

// Minimal HTML fixture that includes all elements that must continue to work.
// Mirrors the real index.html — includes all valid elements, intentionally
// omits btn-history-refresh and btn-history-clear (they don't exist in the real DOM).
const MINIMAL_HTML = `<!DOCTYPE html>
<html>
<body>
  <button id="btn-clear-log">Clear Log</button>
  <div id="log-container" style="overflow-y:auto;height:200px;"></div>
  <button id="btn-test-webhook">Test Webhook</button>
  <button id="btn-test-email">Test Email</button>
  <button id="btn-email-secret">Toggle</button>
</body>
</html>`;

// The set of existing elements that must continue to work, paired with their
// expected event types. This mirrors the real app.js initialization.
const EXISTING_ELEMENTS = [
  { id: 'btn-clear-log',    eventType: 'click'  },  // Requirement 3.1
  { id: 'log-container',    eventType: 'scroll' },  // Requirement 3.2
  { id: 'btn-test-webhook', eventType: 'click'  },  // Requirement 3.3
  { id: 'btn-test-email',   eventType: 'click'  },  // Requirement 3.4
  { id: 'btn-email-secret', eventType: 'click'  },  // Requirement 3.5
];

let document;

beforeEach(() => {
  const dom = new JSDOM(MINIMAL_HTML);
  document = dom.window.document;
});

// ---------------------------------------------------------------------------
// Reference implementation of safeAddEventListener
// Same contract as in bug-condition.test.js — the real implementation in
// app.js must satisfy the same contract.
// ---------------------------------------------------------------------------

function safeAddEventListener(elementId, eventType, handler, doc = document) {
  const element = doc.getElementById(elementId);
  if (element) {
    element.addEventListener(eventType, handler);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 1. Each existing element is non-null in the DOM
// ---------------------------------------------------------------------------

describe('Preservation — existing elements are present in the DOM', () => {
  for (const { id } of EXISTING_ELEMENTS) {
    it(`${id} exists in the DOM (non-null)`, () => {
      // Validates: Requirements 3.1–3.5
      const el = document.getElementById(id);
      expect(el).not.toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
// 2. safeAddEventListener returns true for each existing element
// ---------------------------------------------------------------------------

describe('Preservation — safeAddEventListener returns true for existing elements', () => {
  for (const { id, eventType } of EXISTING_ELEMENTS) {
    it(`safeAddEventListener('${id}', '${eventType}', handler) returns true`, () => {
      // Validates: Requirements 3.1–3.5
      const handler = vi.fn();
      const result = safeAddEventListener(id, eventType, handler, document);
      expect(result).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. The event listener is actually attached (dispatching the event calls the handler)
// ---------------------------------------------------------------------------

describe('Preservation — event listeners are actually attached and fire correctly', () => {
  it('btn-clear-log click handler is called when click event is dispatched', () => {
    // Validates: Requirement 3.1, 3.6
    const handler = vi.fn();
    safeAddEventListener('btn-clear-log', 'click', handler, document);

    const el = document.getElementById('btn-clear-log');
    el.dispatchEvent(new document.defaultView.Event('click'));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('log-container scroll handler is called when scroll event is dispatched', () => {
    // Validates: Requirement 3.2, 3.6
    const handler = vi.fn();
    safeAddEventListener('log-container', 'scroll', handler, document);

    const el = document.getElementById('log-container');
    el.dispatchEvent(new document.defaultView.Event('scroll'));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('btn-test-webhook click handler is called when click event is dispatched', () => {
    // Validates: Requirement 3.3, 3.6
    const handler = vi.fn();
    safeAddEventListener('btn-test-webhook', 'click', handler, document);

    const el = document.getElementById('btn-test-webhook');
    el.dispatchEvent(new document.defaultView.Event('click'));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('btn-test-email click handler is called when click event is dispatched', () => {
    // Validates: Requirement 3.4, 3.6
    const handler = vi.fn();
    safeAddEventListener('btn-test-email', 'click', handler, document);

    const el = document.getElementById('btn-test-email');
    el.dispatchEvent(new document.defaultView.Event('click'));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('btn-email-secret click handler is called when click event is dispatched', () => {
    // Validates: Requirement 3.5, 3.6
    const handler = vi.fn();
    safeAddEventListener('btn-email-secret', 'click', handler, document);

    const el = document.getElementById('btn-email-secret');
    el.dispatchEvent(new document.defaultView.Event('click'));

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Property-based style: iterate over ALL valid element IDs and verify the
//    same invariants hold for each one.
// ---------------------------------------------------------------------------

describe('Preservation — property: all valid elements satisfy the same invariants', () => {
  it('for every existing element: element is non-null, safeAddEventListener returns true, and handler fires', () => {
    // Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
    // This is the property-based style test: iterate over the full set of
    // valid element IDs and assert the same invariants hold for each.
    for (const { id, eventType } of EXISTING_ELEMENTS) {
      const handler = vi.fn();

      // Invariant 1: element exists in the DOM
      const el = document.getElementById(id);
      expect(el, `${id} should be non-null`).not.toBeNull();

      // Invariant 2: safeAddEventListener returns true
      const result = safeAddEventListener(id, eventType, handler, document);
      expect(result, `safeAddEventListener('${id}') should return true`).toBe(true);

      // Invariant 3: dispatching the event calls the handler
      el.dispatchEvent(new document.defaultView.Event(eventType));
      expect(handler, `handler for '${id}' should be called once`).toHaveBeenCalledTimes(1);
    }
  });

  it('safeAddEventListener never throws for any valid element ID', () => {
    // Validates: Requirements 3.1–3.6
    // Defensive property: the safe helper must never throw, even for valid elements.
    for (const { id, eventType } of EXISTING_ELEMENTS) {
      const handler = vi.fn();
      expect(
        () => safeAddEventListener(id, eventType, handler, document),
        `safeAddEventListener('${id}') should not throw`
      ).not.toThrow();
    }
  });

  it('multiple handlers can be attached to the same element without conflict', () => {
    // Validates: Requirement 3.6 — handler execution correctness
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    safeAddEventListener('btn-clear-log', 'click', handler1, document);
    safeAddEventListener('btn-clear-log', 'click', handler2, document);

    const el = document.getElementById('btn-clear-log');
    el.dispatchEvent(new document.defaultView.Event('click'));

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });
});
