/**
 * FXT Telemetry SDK (single-file) - Enhanced with Pain Point Analytics
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
 * Pain Point Analytics (NEW):
 *  - Time spent on each field (focus to blur duration)
 *  - Multiple edits/rewrites tracking (edit count per field)
 *  - Repeated validation failures (count per field)
 *  - Backspace/correction patterns (hesitation indicators)
 *  - Field clear events (user frustration signals)
 *  - Paste events (different interaction pattern)
 *  - Drop-off detection (last field before abandonment)
 *  - Field engagement metrics (focus count, total time, edit count)
 *  - Automatic pain point identification (fields with struggle indicators)
 *  - Periodic field analytics snapshots (every 30s)
 *  - Comprehensive field analytics summary on session end
 *
 * Event Types Sent:
 *  - focus, blur, change, error (validation), paste
 *  - field-analytics (aggregated pain point data)
 *  - session-start, session-end, heartbeat
 *  - dom-mutation, step-transition
 *
 * Privacy Notes:
 *  - DOES NOT include field values (only metadata)
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
    
    // Enhanced tracking for pain point analysis
    FXT._fieldMetrics = {}; // Per-field engagement tracking
    FXT._currentFocusedField = null;
    FXT._fieldFocusStartTime = null;
  
    /* ---------------------------
     * Field Metrics Tracking (Pain Point Analysis)
     * --------------------------- */
    function initFieldMetrics(fieldPath) {
      if (!FXT._fieldMetrics[fieldPath]) {
        FXT._fieldMetrics[fieldPath] = {
          focusCount: 0,
          totalTimeSpent: 0,
          editCount: 0,
          validationFailures: 0,
          lastValueLength: 0,
          backspaceCount: 0,
          pasteCount: 0,
          clearCount: 0,
          lastError: null
        };
      }
      return FXT._fieldMetrics[fieldPath];
    }
    
    function getFieldMetrics(fieldPath) {
      return FXT._fieldMetrics[fieldPath] || null;
    }
    
    // Send aggregated field metrics and identify pain points
    function sendFieldMetricsSummary(reason) {
      // Calculate drop-off point (last focused field)
      const dropOffField = FXT._currentFocusedField;
      
      // Identify pain points (fields with high struggle indicators)
      const painPoints = [];
      const fieldSummaries = [];
      
      for (const [fieldPath, metrics] of Object.entries(FXT._fieldMetrics)) {
        const summary = {
          field: fieldPath,
          focusCount: metrics.focusCount,
          totalTimeSpentMs: metrics.totalTimeSpent,
          editCount: metrics.editCount,
          validationFailures: metrics.validationFailures,
          backspaceCount: metrics.backspaceCount,
          pasteCount: metrics.pasteCount,
          clearCount: metrics.clearCount
        };
        
        fieldSummaries.push(summary);
        
        // Pain point heuristics
        const isPainPoint = 
          metrics.validationFailures > 2 || // Repeated validation failures
          metrics.totalTimeSpent > 30000 || // More than 30 seconds
          metrics.focusCount > 3 || // Returned to field multiple times
          metrics.editCount > 5 || // Many edits/corrections
          metrics.clearCount > 1; // Cleared field multiple times
        
        if (isPainPoint) {
          painPoints.push({
            field: fieldPath,
            reasons: {
              repeatedValidationFailures: metrics.validationFailures > 2,
              excessiveTimeSpent: metrics.totalTimeSpent > 30000,
              multipleReturns: metrics.focusCount > 3,
              manyEdits: metrics.editCount > 5,
              multipleClears: metrics.clearCount > 1
            },
            metrics: summary
          });
        }
      }
      
      // Send comprehensive field analytics event
      enqueue(makeEvent('field-analytics', {
        reason: reason,
        dropOffField: dropOffField,
        totalFieldsInteracted: fieldSummaries.length,
        painPoints: painPoints,
        painPointCount: painPoints.length,
        allFieldMetrics: fieldSummaries
      }));
      
      logDebug('Field analytics:', painPoints.length, 'pain points detected');
    }

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
      logDebug('Flushing', payload.events.length, 'events, bytes', body.length);
  
      // try sendBeacon on unload, else send fetch
      if (navigator.sendBeacon && FXT._isUnloading) {
        try {
          // Wrap in Blob to send as application/json
          const blob = new Blob([body], { type: 'application/json' });
          const sent = navigator.sendBeacon(FXT._config.endpoint, blob);
          if (sent) {
            FXT._lastFlush = Date.now();
            return;
          }
        } catch (e) {
          // fall through to fetch
        }
      }
  
      // Use fetch to send to endpoint
      fetch(FXT._config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'omit',
        body
      }).then(res => {
        FXT._lastFlush = Date.now();
        logDebug('Flush response', res.status);
      }).catch(err => {
        // if network fails, push events back to queue (simple retry)
        logDebug('Flush failed', err);
        // put back events at front (best-effort)
        const returned = JSON.parse(body).events;
        FXT._events = returned.concat(FXT._events);
      });
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
        const fieldPath = cssPath(el);
        const metrics = initFieldMetrics(fieldPath);
        
        // Track focus start time
        FXT._currentFocusedField = fieldPath;
        FXT._fieldFocusStartTime = perfNow();
        metrics.focusCount++;
        
        const info = {
          formSelector: FXT._config.formSelector,
          field: fieldPath,
          tag: el.tagName,
          fieldType: el.type || null,
          step: stepIndexForElement(el),
          valueSummary: valueSummaryForElement(el),
          // Pain point metrics
          focusCount: metrics.focusCount,
          previousValidationFailures: metrics.validationFailures,
          previousEditCount: metrics.editCount
        };
        enqueue(makeEvent('focus', info));
        logDebug('focus', info.field);
      }
  
      function onBlur(e) {
        const el = e.target;
        const fieldPath = cssPath(el);
        const metrics = getFieldMetrics(fieldPath);
        
        // Calculate time spent on this field
        let timeSpent = 0;
        if (FXT._currentFocusedField === fieldPath && FXT._fieldFocusStartTime) {
          timeSpent = Math.round(perfNow() - FXT._fieldFocusStartTime);
          if (metrics) {
            metrics.totalTimeSpent += timeSpent;
          }
        }
        
        FXT._currentFocusedField = null;
        FXT._fieldFocusStartTime = null;
        
        const info = {
          field: fieldPath,
          tag: el.tagName,
          fieldType: el.type || null,
          step: stepIndexForElement(el),
          valueSummary: valueSummaryForElement(el),
          // Pain point metrics
          timeSpentMs: timeSpent,
          totalTimeSpentMs: metrics ? metrics.totalTimeSpent : 0,
          editCount: metrics ? metrics.editCount : 0,
          validationFailures: metrics ? metrics.validationFailures : 0,
          backspaceCount: metrics ? metrics.backspaceCount : 0,
          pasteCount: metrics ? metrics.pasteCount : 0
        };
        enqueue(makeEvent('blur', info));
        logDebug('blur', info.field, `${timeSpent}ms spent`);
      }
  
      function onChange(e) {
        const el = e.target;
        const fieldPath = cssPath(el);
        const metrics = initFieldMetrics(fieldPath);
        const valueSummary = valueSummaryForElement(el);
        
        // Track edits
        metrics.editCount++;
        
        // Detect if field was cleared
        if (metrics.lastValueLength > 0 && valueSummary && valueSummary.length === 0) {
          metrics.clearCount++;
        }
        metrics.lastValueLength = valueSummary ? valueSummary.length : 0;
        
        const info = {
          field: fieldPath,
          tag: el.tagName,
          fieldType: el.type || null,
          step: stepIndexForElement(el),
          valueSummary: valueSummary,
          // Pain point metrics
          editCount: metrics.editCount,
          clearCount: metrics.clearCount
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
          
          // Track validation failures
          if (!el.validity.valid) {
            metrics.validationFailures++;
            metrics.lastError = info.validity;
            info.validationFailureCount = metrics.validationFailures;
          }
        }
        enqueue(makeEvent('change', info));
        logDebug('change', info.field, info.validity);
      }
  
      function onInvalid(e) {
        // capture validation message without values
        const el = e.target;
        const fieldPath = cssPath(el);
        const metrics = initFieldMetrics(fieldPath);
        
        // Track repeated validation failures
        metrics.validationFailures++;
        
        const info = {
          field: fieldPath,
          tag: el.tagName,
          fieldType: el.type || null,
          step: stepIndexForElement(el),
          validity: el.validity ? { ...el.validity } : null,
          // Pain point metrics - CRITICAL for identifying problematic fields
          validationFailureCount: metrics.validationFailures,
          editCount: metrics.editCount,
          timeSpentMs: metrics.totalTimeSpent,
          isRepeatedFailure: metrics.validationFailures > 1
        };
        enqueue(makeEvent('error', Object.assign({ errorType: 'validation' }, info)));
        logDebug('invalid', info.field, `Failure #${metrics.validationFailures}`);
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
  
      // Track keystroke patterns for pain point analysis
      function onKeyDown(e) {
        const el = e.target;
        if (!el || !el.tagName) return;
        const tag = el.tagName.toLowerCase();
        if (tag !== 'input' && tag !== 'textarea') return;
        
        const fieldPath = cssPath(el);
        const metrics = initFieldMetrics(fieldPath);
        
        // Track backspace/delete (indicates corrections/hesitation)
        if (e.key === 'Backspace' || e.key === 'Delete') {
          metrics.backspaceCount++;
        }
      }
      
      // Track paste events (different interaction pattern)
      function onPaste(e) {
        const el = e.target;
        if (!el || !el.tagName) return;
        const fieldPath = cssPath(el);
        const metrics = initFieldMetrics(fieldPath);
        metrics.pasteCount++;
        
        // Log paste event for analysis
        enqueue(makeEvent('paste', {
          field: fieldPath,
          tag: el.tagName,
          fieldType: el.type || null
        }));
      }
      
      form.addEventListener('focus', onFocus, true);
      form.addEventListener('blur', onBlur, true);
      form.addEventListener('change', onChange, true);
      form.addEventListener('invalid', onInvalid, true);
      form.addEventListener('click', onFormClick, true);
      form.addEventListener('keydown', onKeyDown, true);
      form.addEventListener('paste', onPaste, true);
  
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
          // Send field metrics summary before session ends
          sendFieldMetricsSummary('unload');
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
          sendFieldMetricsSummary('hidden');
          enqueue(makeEvent('session-end', { reason: 'hidden' }));
          flush();
        }
      });
  
      // small heartbeat / keepalive event occasionally so session isn't empty
      // Also send field metrics summary periodically for ongoing analysis
      setInterval(() => {
        enqueue(makeEvent('heartbeat', { tSinceStart: Math.round((perfNow() - FXT._startedAt) / 1000) }));
        // Send field analytics snapshot every minute
        if (Object.keys(FXT._fieldMetrics).length > 0) {
          sendFieldMetricsSummary('periodic');
        }
      }, 30000);
  
      logDebug('FXT initialized', FXT._sessionId, FXT._config);
      return FXT;
    };
  
    FXT.stop = function () {
      try {
        if (FXT._mo) FXT._mo.disconnect();
        FXT._isInitialized = false;
        clearTimeout(FXT._flushTimer);
        // Send field metrics summary
        sendFieldMetricsSummary('stop');
        // final flush
        enqueue(makeEvent('session-end', { reason: 'stop' }));
        flush();
      } catch (e) { /* ignore */ }
    };
  
    // exported for dev/debug
    global.FXT = FXT;
  })(window);
  