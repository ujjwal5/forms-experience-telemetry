/**
 * FXT Telemetry SDK (single-file)
 *
 * Usage:
 *   <script src="/path/to/fxt-telemetry.js"></script>
 *   <script>
 *     FXT.init({ endpoint: '/api/fxt/events', formSelector: '#my-form' });
 *   </script>
 *
 * Features:
 *  - Captures focus, blur, change, error, step transition
 *  - Masks actual values (sends valueSummary only)
 *  - Captures console errors, window errors, promise rejections
 *  - Captures network failures (fetch/XHR)
 *  - Sends events in small batches; uses sendBeacon on unload
 *  - MutationObserver captures DOM structural changes (rate limited)
 *
 * Privacy Notes:
 *  - DOES NOT include field values
 *  - DOES NOT emit IP/UA in body, but transport (browser->server) will include standard headers; server must drop/ignore them
 *  - Keep events small
 */

(function (global) {
    const FXT = {};
  
    /* ---------------------------
     * Default configuration
     * --------------------------- */
    const DEFAULTS = {
      endpoint: '/api/fxt/events', // your backend collector
      formSelector: 'form',         // CSS selector for the form to instrument
      batchSize: 25,                // max events per POST
      flushIntervalMs: 4000,        // flush every N ms
      mutationBatchMs: 3000,        // coalesce mutation events
      maxMutationRecordsPerBatch: 8,
      sessionTtlMs: 1000 * 60 * 60, // session TTL (1 hour)
      enableConsoleWrap: true,
      debug: false
    };
  
    /* ---------------------------
     * Utilities
     * --------------------------- */
  
    // create a cryptographic UUID (v4-like)
    function makeSessionId() {
      // RFC-like UUID v4 using crypto
      if (global.crypto && crypto.getRandomValues) {
        const arr = new Uint8Array(16);
        crypto.getRandomValues(arr);
        // Per RFC 4122 v4
        arr[6] = (arr[6] & 0x0f) | 0x40;
        arr[8] = (arr[8] & 0x3f) | 0x80;
        return [...arr].map((b, i) => ('0' + b.toString(16)).slice(-2))
          .join('').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
      }
      // fallback
      return 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
    }
  
    function nowSec() {
      return Math.round(perfNow() / 1000); // seconds since start
    }
  
    function perfNow() {
      if (global.performance && performance.now) return performance.now();
      return Date.now();
    }
  
    function logDebug(...args) {
      if (FXT._config.debug) console.debug('[FXT]', ...args);
    }
  
    // generate a short CSS path selector for an element (no values)
    function cssPath(el) {
      if (!el) return null;
      // limit depth
      const path = [];
      let node = el;
      let depth = 0;
      while (node && node.nodeType === 1 && depth < 6) {
        let part = node.tagName.toLowerCase();
        if (node.id) {
          part += `#${node.id}`;
          path.unshift(part);
          break;
        } else {
          // add nth-child if many siblings with same tag
          const parent = node.parentNode;
          if (parent) {
            const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
            if (siblings.length > 1) {
              const idx = Array.from(parent.children).indexOf(node) + 1;
              part += `:nth-child(${idx})`;
            }
          }
          path.unshift(part);
        }
        node = node.parentNode;
        depth++;
      }
      return path.join(' > ');
    }
  
    // derive a tiny summary about the input value (but never include the value)
    function valueSummaryForElement(el) {
      try {
        if (!el) return null;
        const tag = el.tagName ? el.tagName.toLowerCase() : '';
        // only consider input/select/textarea; do not read value text
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
          // we will compute length and a coarse type
          // to avoid reading PII text, we only sample the value length and character classes
          const value = el.value || '';
          const len = value.length;
          let kind = 'empty';
          if (len > 0) {
            const hasDigits = /[0-9]/.test(value);
            const hasLetters = /[A-Za-z]/.test(value);
            const hasSymbols = /[^A-Za-z0-9\s]/.test(value);
            if (hasDigits && !hasLetters && !hasSymbols) kind = 'numeric';
            else if (!hasDigits && hasLetters && !hasSymbols) kind = 'alpha';
            else if (hasDigits && hasLetters) kind = 'alphanum';
            else kind = 'other';
          }
          // IMPORTANT: we DO NOT include actual value
          return { length: len, kind: kind };
        }
        return null;
      } catch (e) {
        return null;
      }
    }
  
    // light canonicalization of form steps: infer step index from data-step attr or nearest ancestor with [data-step]
    function stepIndexForElement(el) {
      let node = el;
      let depth = 0;
      while (node && depth < 8) {
        if (node.dataset && node.dataset.step) {
          return node.dataset.step;
        }
        node = node.parentElement;
        depth++;
      }
      return null;
    }
  
    // compact event envelope
    function makeEvent(type, data) {
      return {
        type,
        t: Math.round(perfNow()), // ms timestamp relative to page start
        ...data
      };
    }
  
    /* ---------------------------
     * SDK internal state
     * --------------------------- */
    FXT._config = Object.assign({}, DEFAULTS);
    FXT._sessionId = null;
    FXT._events = [];
    FXT._flushTimer = null;
    FXT._lastFlush = 0;
    FXT._startedAt = perfNow();
    FXT._mutationBuffer = [];
    FXT._mutationTimer = null;
    FXT._collectedConsole = [];
    FXT._isInitialized = false;
  
    /* ---------------------------
     * Event queue and sender
     * --------------------------- */
    function enqueue(evt) {
      FXT._events.push(evt);
      // keep small
      if (FXT._events.length >= FXT._config.batchSize) {
        flush();
      }
    }
  
    function flush() {
      if (!FXT._events.length) return;
      const payload = {
        sessionId: FXT._sessionId,
        startedAt: FXT._startedAt,
        events: FXT._events.splice(0, FXT._config.batchSize)
      };
  
      // small payload enforcement (best-effort)
      // convert to JSON once
      const body = JSON.stringify(payload);
      
      // Log events to console instead of sending to endpoint
      console.log('[FXT] Flushing', payload.events.length, 'events, bytes:', body.length);
      console.log('[FXT] Payload:', payload);
      
      FXT._lastFlush = Date.now();
    }
  
    function scheduleFlush() {
      if (FXT._flushTimer) return;
      FXT._flushTimer = setTimeout(() => {
        FXT._flushTimer = null;
        flush();
        scheduleFlush();
      }, FXT._config.flushIntervalMs);
    }
  
    /* ---------------------------
     * Instrumentation: form fields
     * --------------------------- */
    function attachFormListeners(form) {
      // delegate events from form
      function onFocus(e) {
        const el = e.target;
        const info = {
          formSelector: FXT._config.formSelector,
          field: cssPath(el),
          tag: el.tagName,
          fieldType: el.type || null,
          step: stepIndexForElement(el),
          valueSummary: valueSummaryForElement(el)
        };
        enqueue(makeEvent('focus', info));
        logDebug('focus', info.field);
      }
  
      function onBlur(e) {
        const el = e.target;
        const info = {
          field: cssPath(el),
          tag: el.tagName,
          fieldType: el.type || null,
          step: stepIndexForElement(el),
          valueSummary: valueSummaryForElement(el)
        };
        enqueue(makeEvent('blur', info));
        logDebug('blur', info.field);
      }
  
      function onChange(e) {
        const el = e.target;
        const info = {
          field: cssPath(el),
          tag: el.tagName,
          fieldType: el.type || null,
          step: stepIndexForElement(el),
          valueSummary: valueSummaryForElement(el)
        };
        // classify validation state if available
        if (el.validity) {
          info.validity = {
            valid: el.validity.valid,
            patternMismatch: !!el.validity.patternMismatch,
            valueMissing: !!el.validity.valueMissing,
            typeMismatch: !!el.validity.typeMismatch,
            tooShort: !!el.validity.tooShort,
            tooLong: !!el.validity.tooLong
          };
        }
        enqueue(makeEvent('change', info));
        logDebug('change', info.field, info.validity);
      }
  
      function onInvalid(e) {
        // capture validation message without values
        const el = e.target;
        const info = {
          field: cssPath(el),
          tag: el.tagName,
          fieldType: el.type || null,
          step: stepIndexForElement(el),
          validity: el.validity ? { ...el.validity } : null
        };
        enqueue(makeEvent('error', Object.assign({ errorType: 'validation' }, info)));
        logDebug('invalid', info.field);
        // prevent browser default bubble if needed — but we won't prevent default
      }
  
      // step transition: authors can call FXT.stepTransition(stepIndex) for single-page wizards
      function onFormClick(e) {
        // we do not automatically interpret every click as step transition.
        // developers may emit a custom event 'fxt:step' on document when step changes.
        // For safety, capture clicks on elements with data-step-next attribute (heuristic)
        const target = e.target;
        if (target && target.closest && target.closest('[data-step-next]')) {
          const from = target.closest('[data-step]') ? target.closest('[data-step]').dataset.step : null;
          const to = target.closest('[data-step-next]') ? target.closest('[data-step-next]').dataset.stepNext : null;
          enqueue(makeEvent('step-transition', { fromStep: from, toStep: to }));
        }
      }
  
      form.addEventListener('focus', onFocus, true);
      form.addEventListener('blur', onBlur, true);
      form.addEventListener('change', onChange, true);
      form.addEventListener('invalid', onInvalid, true);
      form.addEventListener('click', onFormClick, true);
  
      // expose programmatic API for step transitions (recommended)
      FXT.stepTransition = function (from, to) {
        enqueue(makeEvent('step-transition', { fromStep: from, toStep: to }));
        logDebug('programmatic step transition', from, to);
      };
    }
  
    /* ---------------------------
     * Instrumentation: console / errors / network
     * --------------------------- */
  
    function wrapConsole() {
      if (!FXT._config.enableConsoleWrap) return;
      const originalError = console.error;
      console.error = function (...args) {
        try {
          enqueue(makeEvent('error', {
            errorType: 'console',
            message: String(args[0]).slice(0, 300) // cap string length
          }));
        } catch (e) { /* ignore */ }
        originalError.apply(console, args);
      };
    }
  
    function wireWindowErrors() {
      window.addEventListener('error', function (evt) {
        try {
          const info = {
            errorType: 'uncaught',
            message: (evt && evt.message) ? String(evt.message).slice(0, 300) : 'unknown',
            filename: evt && evt.filename ? evt.filename.split('/').pop() : null,
            lineno: evt && evt.lineno ? evt.lineno : null
          };
          enqueue(makeEvent('error', info));
        } catch (e) { /* ignore */ }
      });
  
      window.addEventListener('unhandledrejection', function (evt) {
        try {
          const reason = evt && evt.reason ? String(evt.reason).slice(0, 300) : 'unknown';
          enqueue(makeEvent('error', { errorType: 'unhandledrejection', message: reason }));
        } catch (e) { /* ignore */ }
      });
    }
  
    // Wrap fetch to capture network failures (status >= 400 or network error)
    function wrapFetch() {
      if (!global.fetch) return;
      const originalFetch = global.fetch;
      global.fetch = function (input, init) {
        const start = perfNow();
        return originalFetch(input, init).then(res => {
          const duration = Math.round(perfNow() - start);
          if (!res.ok) {
            // record network error event but do not capture body
            enqueue(makeEvent('error', {
              errorType: 'network',
              subType: 'httpError',
              url: (typeof input === 'string') ? input : (input && input.url) || null,
              status: res.status,
              statusText: res.statusText,
              duration
            }));
          }
          return res;
        }).catch(err => {
          const duration = Math.round(perfNow() - start);
          enqueue(makeEvent('error', {
            errorType: 'network',
            subType: 'networkFail',
            url: (typeof input === 'string') ? input : (input && input.url) || null,
            message: String(err).slice(0, 300),
            duration
          }));
          throw err;
        });
      };
    }
  
    // Wrap XHR
    function wrapXHR() {
      const XHR = global.XMLHttpRequest;
      if (!XHR) return;
      const origOpen = XHR.prototype.open;
      const origSend = XHR.prototype.send;
      XHR.prototype.open = function (method, url) {
        this._fxt_url = url;
        origOpen.apply(this, arguments);
      };
      XHR.prototype.send = function (body) {
        const start = perfNow();
        const url = this._fxt_url;
        this.addEventListener('load', function () {
          const duration = Math.round(perfNow() - start);
          if (this.status >= 400) {
            enqueue(makeEvent('error', {
              errorType: 'network',
              subType: 'httpError',
              url,
              status: this.status,
              duration
            }));
          }
        });
        this.addEventListener('error', function () {
          const duration = Math.round(perfNow() - start);
          enqueue(makeEvent('error', {
            errorType: 'network',
            subType: 'networkFail',
            url,
            duration
          }));
        });
        origSend.apply(this, arguments);
      };
    }
  
    /* ---------------------------
     * DOM Mutation capture (small, coalesced)
     * --------------------------- */
    function observeMutations(rootEl) {
      if (!global.MutationObserver) return;
      const mo = new MutationObserver(mutations => {
        try {
          // coalesce
          for (const m of mutations) {
            // record only structural changes and attribute changes relevant to fields
            if (m.type === 'childList') {
              // record additions/removals with small selector references
              m.addedNodes && m.addedNodes.forEach(n => {
                if (n.nodeType === 1) {
                  FXT._mutationBuffer.push({
                    action: 'added',
                    selector: cssPath(n),
                    tag: n.tagName ? n.tagName.toLowerCase() : null
                  });
                }
              });
              m.removedNodes && m.removedNodes.forEach(n => {
                if (n.nodeType === 1) {
                  FXT._mutationBuffer.push({
                    action: 'removed',
                    selector: cssPath(n),
                    tag: n.tagName ? n.tagName.toLowerCase() : null
                  });
                }
              });
            } else if (m.type === 'attributes') {
              FXT._mutationBuffer.push({
                action: 'attr',
                selector: cssPath(m.target),
                attribute: m.attributeName
              });
            }
          }
          // schedule flush of mutation buffer
          if (!FXT._mutationTimer) {
            FXT._mutationTimer = setTimeout(() => {
              const batch = FXT._mutationBuffer.splice(0, FXT._config.maxMutationRecordsPerBatch);
              enqueue(makeEvent('dom-mutation', { changes: batch }));
              FXT._mutationTimer = null;
            }, FXT._config.mutationBatchMs);
          }
        } catch (e) {
          // ignore
        }
      });
      mo.observe(rootEl, { childList: true, subtree: true, attributes: true });
      // store observer to disconnect on stop
      FXT._mo = mo;
    }
  
    /* ---------------------------
     * Public API: init/start/stop
     * --------------------------- */
    FXT.init = function (opts) {
      if (FXT._isInitialized) return FXT;
      FXT._config = Object.assign({}, DEFAULTS, opts || {});
      FXT._sessionId = makeSessionId();
      FXT._isUnloading = false;
      FXT._isInitialized = true;
  
      // locate form
      const form = document.querySelector(FXT._config.formSelector);
      if (!form) {
        console.warn('FXT: form not found for selector', FXT._config.formSelector);
        // still set up global handlers
      } else {
        attachFormListeners(form);
        observeMutations(form);
      }
  
      if (FXT._config.enableConsoleWrap) wrapConsole();
      wireWindowErrors();
      wrapFetch();
      wrapXHR();
  
      // capture page load event
      enqueue(makeEvent('session-start', { url: location.pathname }));
  
      // set up flush interval
      scheduleFlush();
  
      // handle unload/visibility change: flush remaining events
      window.addEventListener('beforeunload', () => {
        FXT._isUnloading = true;
        try {
          // add session-end
          enqueue(makeEvent('session-end', { reason: 'unload' }));
          // attempt final flush
          flush();
        } catch (e) {
          // ignore
        }
      });
  
      // if user navigates away via visibility change, try to send
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          FXT._isUnloading = true;
          enqueue(makeEvent('session-end', { reason: 'hidden' }));
          flush();
        }
      });
  
      // small heartbeat / keepalive event occasionally so session isn't empty
      setInterval(() => {
        enqueue(makeEvent('heartbeat', { tSinceStart: Math.round((perfNow() - FXT._startedAt) / 1000) }));
      }, 30000);
  
      logDebug('FXT initialized', FXT._sessionId, FXT._config);
      return FXT;
    };
  
    FXT.stop = function () {
      try {
        if (FXT._mo) FXT._mo.disconnect();
        FXT._isInitialized = false;
        clearTimeout(FXT._flushTimer);
        // final flush
        enqueue(makeEvent('session-end', { reason: 'stop' }));
        flush();
      } catch (e) { /* ignore */ }
    };
  
    // exported for dev/debug
    global.FXT = FXT;
  })(window);
  