/*
 * anim-cli in-page runtime (plain browser JavaScript, no build step).
 *
 * Loaded two ways:
 *   - `build` inlines it before </body> followed by `__anim.boot({...timeline...})`;
 *   - `record`/`check`/`preview`/`export` inject it via Playwright (addInitScript or
 *     addScriptTag) and drive it step by step from Node with `__anim.runStep(step, {leadMs})`.
 *
 * It holds the visual primitives (cursor, spotlight highlight, click ripple, typing,
 * camera, scroll, subtitles, fades) and a ~20-line optional scheduler (`play`) used
 * only when animated.html is opened directly in a browser. When Node drives the page
 * it sets `window.__ANIM_DRIVEN = true` before load so `boot` never self-plays.
 *
 * Timing: a step's `timeMs` is the moment the interaction happens. `runStep` is
 * started `leadMs` earlier and spends `leadMs - 150` travelling the cursor, then
 * highlights + presses for 150ms, then acts and dispatches `anim:step`.
 *
 * Must not use require/import/TypeScript. Must survive injection at document start
 * (DOM creation is deferred until DOMContentLoaded when document.body is null).
 */
(function () {
  'use strict';
  if (window.__anim) return;

  var PRESS_MS = 150;
  var DEFAULT_LEAD_MS = 950;
  var DEFAULT_CPS = 25;
  var DEFAULT_CAMERA_S = 2.5;
  var FADE_MS = 800;
  var SCROLL_MS = 600;

  var ALIASES = { showText: 'fadeIn' };
  var CURSOR_ACTIONS = { click: 1, focus: 1, type: 1, highlight: 1, hover: 1 };
  var TARGET_REQUIRED = { click: 1, focus: 1, type: 1, highlight: 1, hover: 1, scroll: 1, fadeIn: 1, transitionScreen: 1 };

  // --- CSS (ported verbatim from the previous inline engine) ---------------------
  var CURSOR_CSS = {
    mac: `#anim-cli-cursor { position: fixed; top: 0; left: 0; transform: translate(50vw, 120vh); width: 28px; height: 28px; z-index: 99999; pointer-events: none; background: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%230F172A" stroke="white" stroke-width="1.5"><path d="M4 2v20l5.83-5.83 3.96 8.5 3.65-1.7-3.96-8.5H22L4 2z"/></svg>') no-repeat; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3)); transform-origin: top left; transition: transform 0.8s cubic-bezier(0.16, 1, 0.3, 1); }`,
    windows: `#anim-cli-cursor { position: fixed; top: 0; left: 0; transform: translate(50vw, 120vh); width: 20px; height: 20px; z-index: 99999; pointer-events: none; background: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white" stroke="black" stroke-width="1"><path d="M2 2l20 10-8 2-2 8z"/></svg>') no-repeat; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3)); transform-origin: top left; transition: transform 0.8s cubic-bezier(0.16, 1, 0.3, 1); }`
  };
  var SUBTITLE_CSS = `#anim-cli-subtitle-layer { position: fixed; bottom: 40px; left: 0; right: 0; display: flex; justify-content: center; z-index: 99998; pointer-events: none; padding: 0 40px; }
.anim-cli-sub-item { position: absolute; bottom: 0; background: rgba(20,20,20,0.75); color: white; padding: 16px 32px; border-radius: 12px; font-family: -apple-system, sans-serif; font-size: 20px; line-height: 1.4; text-align: center; max-width: 800px; box-shadow: 0 20px 40px -8px rgba(0,0,0,0.5); opacity: 0; font-weight: 500; letter-spacing: 0.3px; backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,0.15); }
@keyframes anim-cli-subFade { 0% { opacity: 0; transform: translateY(15px) scale(0.95); animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); } 10%, 90% { opacity: 1; transform: translateY(0) scale(1); animation-timing-function: cubic-bezier(0.7, 0, 0.84, 0); } 100% { opacity: 0; transform: translateY(-10px) scale(0.95); } }`;
  var EFFECTS_CSS = `#anim-cli-highlight { position: fixed; border-radius: 10px; border: 2px solid #3B82F6; box-shadow: 0 0 0 4px rgba(59,130,246,0.18), 0 0 28px rgba(59,130,246,0.35); pointer-events: none; z-index: 99996; opacity: 0; transition: left 0.5s cubic-bezier(0.16,1,0.3,1), top 0.5s cubic-bezier(0.16,1,0.3,1), width 0.5s cubic-bezier(0.16,1,0.3,1), height 0.5s cubic-bezier(0.16,1,0.3,1); }
#anim-cli-highlight.anim-cli-pulse { animation: anim-cli-highlightPulse 1.3s cubic-bezier(0.16,1,0.3,1) forwards; }
#anim-cli-highlight.anim-cli-hold { opacity: 1; animation: none; }
@keyframes anim-cli-highlightPulse { 0% { opacity: 0; } 15% { opacity: 1; } 75% { opacity: 1; } 100% { opacity: 0; } }
.anim-cli-ripple { position: fixed; width: 14px; height: 14px; margin-left: -7px; margin-top: -7px; border-radius: 50%; background: rgba(59,130,246,0.35); border: 2px solid rgba(59,130,246,0.65); pointer-events: none; z-index: 99997; animation: anim-cli-rippleAnim 0.6s cubic-bezier(0.16,1,0.3,1) forwards; }
@keyframes anim-cli-rippleAnim { 0% { width: 14px; height: 14px; margin-left: -7px; margin-top: -7px; opacity: 0.9; } 100% { width: 80px; height: 80px; margin-left: -40px; margin-top: -40px; opacity: 0; } }
#anim-cli-callout { position: fixed; width: 32px; height: 32px; border-radius: 50%; background: #3B82F6; color: #fff; font: 600 15px/32px -apple-system, sans-serif; text-align: center; box-shadow: 0 4px 12px rgba(0,0,0,0.25); pointer-events: none; z-index: 99998; display: none; }`;

  // --- state ----------------------------------------------------------------------
  var state = {
    booted: false,
    ready: false,
    opts: { cursor: 'mac', resetFocusStyles: false, drift: true, loop: false, timeline: null, durationMs: null, cursorPoint: null },
    cursor: null,
    subtitleLayer: null,
    subtitleEl: null,
    point: null,
    t0: null,
    currentScreen: null,
    timers: []
  };

  function onReady(fn) {
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', fn, { once: true });
  }
  function overlayRoot() {
    // A transformed <body> becomes the containing block for its position:fixed descendants,
    // which would double-apply the camera/zoom transform to the cursor/highlight/ripple overlays.
    // Reparent them to <html> (never transformed) so they stay correctly viewport-relative.
    return document.documentElement;
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, Math.max(0, ms || 0)); }); }
  function now() {
    if (state.t0 == null) state.t0 = performance.now();
    return Math.round(performance.now() - state.t0);
  }
  function dispatch(name, detail) {
    try { window.dispatchEvent(new CustomEvent(name, { detail: detail })); } catch (e) { /* ignore */ }
  }
  function parseTime(t) {
    if (typeof t === 'number') return Math.round(t * 1000);
    if (typeof t !== 'string') return NaN;
    var s = t.trim(), m;
    if ((m = /^(-?\d+(?:\.\d+)?)\s*ms$/i.exec(s))) return Math.round(parseFloat(m[1]));
    if ((m = /^(-?\d+(?:\.\d+)?)\s*s?$/i.exec(s))) return Math.round(parseFloat(m[1]) * 1000);
    return NaN;
  }
  function timeMsOf(step) { return typeof step.timeMs === 'number' ? step.timeMs : parseTime(step.time); }
  function rectOf(el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  // --- boot: styles + overlays ----------------------------------------------------
  function installStyles() {
    if (document.getElementById('anim-cli-runtime-style')) return;
    var css = '';
    if (state.opts.cursor && state.opts.cursor !== 'none') css += (CURSOR_CSS[state.opts.cursor] || CURSOR_CSS.mac) + '\n';
    css += SUBTITLE_CSS + '\n' + EFFECTS_CSS + '\n';
    var style = document.createElement('style');
    style.id = 'anim-cli-runtime-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function createOverlays() {
    var root = overlayRoot();
    var cursor = document.getElementById('anim-cli-cursor');
    if (state.opts.cursor && state.opts.cursor !== 'none') {
      if (!cursor) { cursor = document.createElement('div'); cursor.id = 'anim-cli-cursor'; }
      root.appendChild(cursor);
      state.cursor = cursor;
    } else if (cursor) {
      cursor.remove();
    }
    var layer = document.getElementById('anim-cli-subtitle-layer');
    if (!layer) { layer = document.createElement('div'); layer.id = 'anim-cli-subtitle-layer'; }
    root.appendChild(layer);
    state.subtitleLayer = layer;
  }

  function applyDrift() {
    var stage = document.body;
    if (state.opts.drift === false) return;
    stage.style.transformOrigin = 'center center';
    stage.style.transition = 'transform 16s cubic-bezier(0.16, 1, 0.3, 1)';
    stage.style.transform = 'scale(1.025)';
  }

  function boot(opts) {
    opts = opts || {};
    for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) state.opts[k] = opts[k];
    onReady(function () {
      if (!state.booted) {
        state.booted = true;
        installStyles();
        createOverlays();
        document.body.style.transformOrigin = 'center center';
        applyDrift();
      }
      if (state.opts.cursorPoint && state.cursor) placeCursor(state.opts.cursorPoint.x, state.opts.cursorPoint.y);
      state.ready = true;
      dispatch('anim:ready', { driven: !!window.__ANIM_DRIVEN });
      if (state.opts.timeline && !window.__ANIM_DRIVEN) {
        play(state.opts.timeline, { loop: !!state.opts.loop, durationMs: state.opts.durationMs });
      }
    });
    return api;
  }

  // --- primitives -----------------------------------------------------------------
  function placeCursor(x, y) {
    if (!state.cursor) return;
    state.cursor.style.transition = 'none';
    state.cursor.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
    void state.cursor.offsetWidth;
    state.point = { x: x, y: y };
  }
  function moveCursor(x, y, ms) {
    if (!state.cursor) return;
    if (!ms || ms <= 0) { placeCursor(x, y); return; }
    state.cursor.style.transition = 'transform ' + ms + 'ms cubic-bezier(0.16, 1, 0.3, 1)';
    state.cursor.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
    state.point = { x: x, y: y };
  }
  function pressCursor(x, y, ms) {
    if (!state.cursor) return;
    state.cursor.style.transition = 'transform ' + Math.max(0, ms) + 'ms ease';
    state.cursor.style.transform = 'translate(' + x + 'px, ' + y + 'px) scale(0.85)';
  }
  function releaseCursor(x, y) {
    if (!state.cursor) return;
    state.cursor.style.transition = 'transform 150ms ease';
    state.cursor.style.transform = 'translate(' + x + 'px, ' + y + 'px) scale(1)';
  }

  function ripple(x, y) {
    var r = document.createElement('div');
    r.className = 'anim-cli-ripple';
    r.style.left = x + 'px';
    r.style.top = y + 'px';
    overlayRoot().appendChild(r);
    setTimeout(function () { r.remove(); }, 700);
  }

  function getHighlightBox() {
    var h = document.getElementById('anim-cli-highlight');
    if (!h) {
      h = document.createElement('div');
      h.id = 'anim-cli-highlight';
      overlayRoot().appendChild(h);
    }
    return h;
  }

  function positionHighlight(el) {
    var rect = el.getBoundingClientRect();
    var h = getHighlightBox();
    h.style.left = (rect.left - 6) + 'px';
    h.style.top = (rect.top - 6) + 'px';
    h.style.width = (rect.width + 12) + 'px';
    h.style.height = (rect.height + 12) + 'px';
    return h;
  }

  function highlight(el) {
    if (!el) return;
    var h = positionHighlight(el);
    h.classList.remove('anim-cli-hold');
    h.classList.remove('anim-cli-pulse');
    void h.offsetWidth;
    h.classList.add('anim-cli-pulse');
  }
  /** Keep the spotlight on `el` until releaseHighlight() (used for guide screenshots). */
  function holdHighlight(el) {
    if (!el) return;
    var h = positionHighlight(el);
    h.classList.remove('anim-cli-pulse');
    h.classList.add('anim-cli-hold');
  }
  function releaseHighlight() {
    var h = document.getElementById('anim-cli-highlight');
    if (h) { h.classList.remove('anim-cli-hold'); h.classList.remove('anim-cli-pulse'); }
  }

  function showCallout(n, el) {
    var c = document.getElementById('anim-cli-callout');
    if (!c) { c = document.createElement('div'); c.id = 'anim-cli-callout'; overlayRoot().appendChild(c); }
    var rect = el.getBoundingClientRect();
    c.textContent = String(n);
    c.style.left = (rect.left - 6 - 16) + 'px';
    c.style.top = (rect.top - 6 - 16) + 'px';
    c.style.display = 'block';
    return { number: n, x: rect.left - 6 - 16, y: rect.top - 6 - 16 };
  }
  function hideCallout() {
    var c = document.getElementById('anim-cli-callout');
    if (c) c.style.display = 'none';
  }

  function resetFocusStyles() {
    document.querySelectorAll('.input, button').forEach(function (n) {
      n.style.borderColor = '#E2E8F0';
      n.style.boxShadow = 'none';
      n.style.background = (n.tagName === 'BUTTON' && n.classList.contains('btn-primary')) ? '#3B82F6' : '#FAFAFA';
    });
  }
  function focusStyle(el) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.style.borderColor = '#3B82F6';
      el.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.15)';
      el.style.background = '#FFF';
    }
  }

  function isField(el) { return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'; }
  // Always assign the whole prefix: `innerText += ' '` loses the trailing space (innerText reads
  // back collapsed whitespace), so typing "a b" char by char would render as "ab".
  function setTyped(el, text) {
    if (isField(el)) el.value = text; else el.textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function typeInto(el, value, cps, instant) {
    value = value == null ? '' : String(value);
    setTyped(el, '');
    if (instant) {
      setTyped(el, value);
      return Promise.resolve();
    }
    var interval = 1000 / (cps > 0 ? cps : (state.opts.defaultCps || DEFAULT_CPS));
    return new Promise(function (resolve) {
      var i = 0;
      function tick() {
        if (i < value.length) {
          i++;
          setTyped(el, value.slice(0, i));
        } else {
          clearInterval(intId);
          resolve();
        }
      }
      tick(); // first character lands exactly at the interaction moment
      var intId = setInterval(tick, interval);
      if (value.length <= 1) { clearInterval(intId); resolve(); }
    });
  }

  function camera(step, instant) {
    var stage = document.body;
    var x = step.x != null ? step.x : '0px';
    var y = step.y != null ? step.y : '0px';
    // A bare number here would produce an invalid unitless translate() and drop the whole transform.
    if (typeof x === 'number') x = x + 'px';
    if (typeof y === 'number') y = y + 'px';
    var scale = step.scale || 1;
    if (step.target) {
      var el = document.querySelector(step.target);
      if (el) {
        // Measure with the body transform removed so consecutive camera moves never compound:
        // the target's untransformed position is what `scale() translate()` is computed from.
        var current = getComputedStyle(stage).transform;
        var prevTransition = stage.style.transition;
        stage.style.transition = 'none';
        stage.style.transform = 'none';
        var r = el.getBoundingClientRect();
        stage.style.transform = current === 'none' ? '' : current;
        void stage.offsetWidth;
        stage.style.transition = prevTransition;
        var cx = r.left + r.width / 2 - window.innerWidth / 2;
        var cy = r.top + r.height / 2 - window.innerHeight / 2;
        x = (-cx) + 'px';
        y = (-cy) + 'px';
      }
    }
    var dur = instant ? 0 : (step.duration != null ? step.duration : DEFAULT_CAMERA_S);
    stage.style.transformOrigin = 'center center';
    stage.style.transition = dur > 0 ? 'transform ' + dur + 's cubic-bezier(0.65, 0, 0.35, 1)' : 'none';
    stage.style.transform = 'scale(' + scale + ') translate(' + x + ', ' + y + ')';
    if (dur === 0) void stage.offsetWidth;
    return wait(dur * 1000);
  }

  function scrollTo(el, instant) {
    el.scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'center' });
    return wait(instant ? 0 : SCROLL_MS);
  }

  function isVisible(el) {
    var cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }
  function fadeIn(el, instant) {
    var ms = instant ? 0 : FADE_MS;
    var cs = getComputedStyle(el);
    // Does the element already transition its own opacity (e.g. `transition: all 3s`)? Then let it.
    var props = (cs.transitionProperty || '').split(',').map(function (s) { return s.trim(); });
    var durs = (cs.transitionDuration || '').split(',').map(function (s) { return parseFloat(s) || 0; });
    var ownOpacityMs = 0;
    props.forEach(function (p, i) {
      if (p === 'opacity' || p === 'all') ownOpacityMs = Math.max(ownOpacityMs, (durs[i] != null ? durs[i] : durs[0]) * 1000);
    });
    var inlineTransition = el.style.transition;
    if (cs.display === 'none') {
      el.style.display = el.getAttribute('data-anim-display') || '';
      if (getComputedStyle(el).display === 'none') el.style.display = 'block';
      el.style.opacity = '0';
      void el.offsetWidth;
    } else if (parseFloat(cs.opacity) >= 1) {
      el.style.transition = 'none';
      el.style.opacity = '0';
      void el.offsetWidth;
      el.style.transition = inlineTransition;
    }
    if (!ownOpacityMs && ms > 0) {
      // Add an opacity transition without dropping an existing inline one (e.g. the body's camera transform).
      el.style.transition = (inlineTransition ? inlineTransition + ', ' : '') + 'opacity ' + ms + 'ms ease';
    }
    el.style.opacity = '1';
    return wait(instant ? 0 : Math.max(ms, ownOpacityMs));
  }
  function transitionScreen(el, instant) {
    var ms = instant ? 0 : FADE_MS;
    var prev = [];
    if (state.currentScreen && state.currentScreen !== el) prev = [state.currentScreen];
    else if (el.parentElement) {
      prev = Array.prototype.filter.call(el.parentElement.children, function (c) {
        return c !== el && !(c.id && c.id.indexOf('anim-cli') === 0) && c.tagName !== 'SCRIPT' && c.tagName !== 'STYLE' && isVisible(c);
      });
    }
    prev.forEach(function (p) {
      p.style.transition = 'opacity ' + Math.round(ms / 2) + 'ms ease';
      p.style.opacity = '0';
      setTimeout(function () { p.style.display = 'none'; }, Math.round(ms / 2));
    });
    state.currentScreen = el;
    return wait(Math.round(ms / 2)).then(function () { return fadeIn(el, instant); });
  }

  function showSubtitle(text, ms) {
    if (!state.subtitleLayer) return;
    var el = state.subtitleEl;
    if (!el) {
      el = document.createElement('div');
      el.className = 'anim-cli-sub-item';
      state.subtitleLayer.appendChild(el);
      state.subtitleEl = el;
    }
    el.innerHTML = text;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = 'anim-cli-subFade ' + Math.max(1, ms || 4000) + 'ms ease forwards';
  }
  function hideSubtitle() {
    if (state.subtitleEl) { state.subtitleEl.style.animation = 'none'; state.subtitleEl.style.opacity = '0'; }
  }

  // --- runStep: one step, from cursor travel to interaction --------------------------
  function runStep(step, o) {
    o = o || {};
    return new Promise(function (resolve, reject) {
      onReady(function () {
        if (!state.booted) boot({});
        try { runStepReady(step, o, resolve, reject); } catch (e) { reject(e); }
      });
    });
  }

  function runStepReady(step, o, resolve, reject) {
    var action = ALIASES[step.action] || step.action;
    var instant = !!o.instant;
    var leadMs = instant ? 0 : (typeof o.leadMs === 'number' ? Math.max(0, o.leadMs) : DEFAULT_LEAD_MS);
    var el = null;
    if (typeof step.target === 'string' && step.target.trim()) {
      el = step.target === 'body' ? document.body : document.querySelector(step.target);
      if (!el && TARGET_REQUIRED[action]) {
        reject(new Error('target not found: ' + step.target));
        return;
      }
    } else if (TARGET_REQUIRED[action]) {
      reject(new Error('action "' + action + '" requires a target'));
      return;
    }

    var point = null;
    if (el && CURSOR_ACTIONS[action]) {
      var rect = el.getBoundingClientRect();
      var tx = rect.left + rect.width / 2;
      var ty = rect.top + rect.height / 2;
      if (step.xOffset) tx += parseFloat(step.xOffset);
      if (step.yOffset) ty += parseFloat(step.yOffset);
      point = { x: tx, y: ty };
    }

    var travelMs = Math.max(0, leadMs - PRESS_MS);
    var pressMs = Math.min(PRESS_MS, leadMs);

    if (point) moveCursor(point.x, point.y, travelMs);

    setTimeout(function () {
      if (el && CURSOR_ACTIONS[action]) highlight(el);
      if (point) pressCursor(point.x, point.y, pressMs);
      setTimeout(function () {
        if (point) releaseCursor(point.x, point.y);
        interact();
      }, pressMs);
    }, travelMs);

    function interact() {
      var actualMs = now();
      var result = {
        index: step.index,
        id: step.id,
        action: action,
        target: step.target,
        scheduledMs: timeMsOf(step),
        actualMs: actualMs,
        rect: rectOf(el),
        point: point
      };
      if (step.subtitle) showSubtitle(step.subtitle, step.subtitleMs);
      var done = Promise.resolve();
      try {
        switch (action) {
          case 'click':
            if (state.opts.resetFocusStyles) resetFocusStyles();
            if (point) ripple(point.x, point.y);
            el.focus();
            // el.click() (not el.onclick()) so checkbox toggling, addEventListener
            // listeners, and default actions all fire like a real user click.
            el.click();
            focusStyle(el);
            break;
          case 'focus':
            if (state.opts.resetFocusStyles) resetFocusStyles();
            el.focus();
            focusStyle(el);
            break;
          case 'type':
            if (state.opts.resetFocusStyles) resetFocusStyles();
            el.focus();
            focusStyle(el);
            done = typeInto(el, step.value, step.cps, instant);
            break;
          case 'hover':
            el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseenter'));
            break;
          case 'highlight':
          case 'wait':
          case 'navigate': // handled by the Node driver (page.goto); no-op in the page
          case 'press':    // handled by the Node driver (keyboard.press); no-op in the page
            break;
          case 'camera':
            done = camera(step, instant);
            break;
          case 'scroll':
            done = scrollTo(el, instant);
            break;
          case 'fadeIn':
            done = fadeIn(el, instant);
            break;
          case 'transitionScreen':
            done = transitionScreen(el, instant);
            break;
          default:
            throw new Error('unknown action: ' + action);
        }
      } catch (e) {
        dispatch('anim:step', result);
        reject(e);
        return;
      }
      dispatch('anim:step', result);
      done.then(function () { resolve(result); }, reject);
    }
  }

  // --- optional in-page scheduler (only when animated.html is opened directly) ---------
  function leadFor(step, prev) {
    var t = timeMsOf(step);
    var lead = DEFAULT_LEAD_MS;
    if (isFinite(t)) lead = Math.min(lead, Math.max(0, t));
    if (prev && isFinite(timeMsOf(prev)) && isFinite(t)) lead = Math.min(lead, Math.max(0, t - timeMsOf(prev)));
    return lead;
  }
  function start() { state.t0 = performance.now(); return 0; }
  function play(timeline, o) {
    o = o || {};
    var steps = Array.isArray(timeline) ? timeline : (timeline && timeline.steps) || [];
    stop();
    start();
    var prev = null, maxMs = 0;
    steps.forEach(function (step, i) {
      if (step.index == null) step.index = i + 1;
      var t = timeMsOf(step);
      if (!isFinite(t)) return;
      var lead = leadFor(step, prev);
      maxMs = Math.max(maxMs, t);
      state.timers.push(setTimeout(function () {
        runStep(step, { leadMs: lead }).catch(function (e) { console.warn('[anim-cli] step ' + step.index + ': ' + e.message); });
      }, Math.max(0, t - lead)));
      prev = step;
    });
    var durationMs = o.durationMs || (maxMs + 2500);
    if (o.loop) state.timers.push(setTimeout(function () { location.reload(); }, durationMs));
    dispatch('anim:play', { steps: steps.length, durationMs: durationMs, loop: !!o.loop });
  }
  function stop() {
    state.timers.forEach(clearTimeout);
    state.timers = [];
  }

  var api = {
    version: 1,
    boot: boot,
    start: start,
    play: play,
    stop: stop,
    runStep: runStep,
    now: now,
    isReady: function () { return state.ready; },
    getState: function () { return { ready: state.ready, point: state.point, opts: state.opts, cursor: !!state.cursor }; },
    moveCursor: moveCursor,
    placeCursor: placeCursor,
    highlight: highlight,
    holdHighlight: holdHighlight,
    releaseHighlight: releaseHighlight,
    showCallout: showCallout,
    hideCallout: hideCallout,
    ripple: ripple,
    typeInto: typeInto,
    camera: camera,
    scroll: scrollTo,
    fadeIn: fadeIn,
    transitionScreen: transitionScreen,
    showSubtitle: showSubtitle,
    hideSubtitle: hideSubtitle
  };
  window.__anim = api;
})();
