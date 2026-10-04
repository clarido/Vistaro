// The studio's preview bridge: the editor's hands inside the mockup. Injected after the tour
// scheduler in the preview page the `studio` command serves. The editor drives transport with the
// unchanged 'anim-tour' protocol and talks to THIS bridge over 'anim-studio' for everything an
// editor needs that a tour does not:
//
//   parent -> { type: 'reload', steps, meta }        swap the timeline in place (fresh 'ready')
//   parent -> { type: 'pick', enable }               target picking (click -> 'picked')
//   parent -> { type: 'manipulate', enable, mode }   direct manipulation:
//       mode 'motion'  click selects an element (frame + handles); dragging the frame translates
//                      it and a corner scales it -- on release the editor writes to.x/to.y/to.scale
//                      on the selected animate step, and the normal live reload shows the truth.
//                      The cursor glyph is also grabbable; dragging it writes step.xOffset/yOffset.
//       mode 'layout'  same gestures, but the editor turns the deltas into an inline-style patch
//                      for index.html (absolute/fixed elements only; the bridge refuses the rest).
//
// Outbound: 'ready'/'state'/'end'/'error' come from the tour bridge; this bridge posts 'picked',
// 'pick-state', 'selected', 'deselected', 'dragged' {selector, dx, dy}, 'resized' {selector, scale},
// 'cursor-dragged' {dx, dy}, 'layout' {tag, index, domCount, patch}, 'layout-refused' {reason},
// 'manip-state' {on, mode}, 'reload-failed'.
//
// Space rules: pointer math stays in painted px (clientX/Y == getBoundingClientRect space, camera
// and zoom already baked in); authored output divides by zoom * cameraWindow.scale. Gesture
// feedback sets inline styles directly and restores them after -- the commit goes through the
// editor's reload (restart clears everything), so WAAPI fills never fight stored state.
//
// Plain browser JavaScript, no imports, injected as text (see inject.ts conventions).
(function () {
  if (window.__studio) return;

  var UP = location.origin && location.origin !== 'null' ? location.origin : '*';

  function post(type, extra) {
    var msg = { source: 'anim-studio', type: type };
    if (extra) for (var k in extra) msg[k] = extra[k];
    parent.postMessage(msg, UP);
  }

  /** Painted px -> authored px (root zoom times an active camera scale). */
  function authoredFactor() {
    var z = 1, s = 1;
    try { z = ((window.__anim.getState() || {}).opts || {}).zoom || 1; } catch (e) { /* keep 1 */ }
    try {
      var cam = window.__anim.overlayState().camera;
      if (cam && cam.scale) s = cam.scale;
    } catch (e) { /* keep 1 */ }
    return z * s;
  }
  /** Painted px -> cursor-overlay px (the cursor lives outside the camera; only root zoom applies). */
  function cursorFactor() {
    try { return ((window.__anim.getState() || {}).opts || {}).zoom || 1; } catch (e) { return 1; }
  }

  // ---- pick mode (unchanged contract) -----------------------------------------
  var picking = false;
  var hovered = null;

  function clearHover() {
    if (!hovered) return;
    hovered.el.style.outline = hovered.prevOutline;
    hovered.el.style.outlineOffset = hovered.prevOffset;
    hovered = null;
  }

  function onMove(e) {
    if (!picking) return;
    var el = e.target;
    if (!el || el === document.documentElement || el === document.body || el === hovered?.el) return;
    clearHover();
    hovered = { el: el, prevOutline: el.style.outline, prevOffset: el.style.outlineOffset };
    el.style.outline = '2px solid #E4632B';
    el.style.outlineOffset = '1px';
    e.stopPropagation();
  }

  function onPickClick(e) {
    if (!picking) return;
    e.preventDefault();
    e.stopPropagation();
    var el = e.target;
    setPick(false);
    if (!el || el === document.documentElement || el === document.body) return;
    var selector = '';
    try { selector = window.__anim.selectorOf(el); } catch (err) { selector = ''; }
    post('picked', {
      selector: selector,
      tag: el.tagName ? el.tagName.toLowerCase() : '',
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90),
    });
  }

  function onKey(e) {
    if (e.key === 'Escape' || e.keyCode === 27) {
      if (picking) setPick(false);
      else if (manipulating) deselect();
    }
  }

  function setPick(on) {
    picking = !!on;
    if (picking) deselect();
    if (!picking) clearHover();
    document.documentElement.style.cursor = picking ? 'crosshair' : '';
    post('pick-state', { on: picking });
  }

  // ---- selection frame ---------------------------------------------------------
  // A fixed-position overlay under <html> (outside the body camera transform, like the runtime's
  // own overlays), so its coordinates are painted/client px: exactly getBoundingClientRect space.
  var frame = null;      // {root, badge}
  var sel = null;        // {el, selector, tag, index, baseTransform}
  var manipulating = false;
  var manipMode = 'motion';

  function frameRoot() {
    if (frame) return frame.root;
    var root = document.createElement('div');
    root.setAttribute('data-studio-frame', '');
    root.style.cssText = 'position:fixed; z-index:99998; pointer-events:none; inset:auto;';
    var box = document.createElement('div');
    box.style.cssText = 'position:absolute; inset:0; border:1px solid #E4632B; border-radius:2px; pointer-events:auto; cursor:move;';
    var badge = document.createElement('div');
    badge.style.cssText = 'position:absolute; left:0; top:-22px; white-space:nowrap; font:600 11px/1.4 ui-monospace,Menlo,monospace; color:#E8EDF7; background:rgba(5,7,13,.88); border:1px solid #1D2739; border-radius:5px; padding:2px 6px; pointer-events:none;';
    badge.hidden = true;
    root.appendChild(box);
    root.appendChild(badge);
    ['nw', 'ne', 'se', 'sw'].forEach(function (corner) {
      var h = document.createElement('div');
      h.setAttribute('data-handle', corner);
      // 12px hit area with a 7px painted dot, centred on the corner.
      h.style.cssText = 'position:absolute; width:12px; height:12px; margin:-6px; border-radius:50%;'
        + 'background:#05070D; border:1.5px solid #E4632B; pointer-events:auto;';
      if (corner === 'nw') h.style.left = '0', h.style.top = '0';
      if (corner === 'ne') h.style.right = '0', h.style.top = '0';
      if (corner === 'se') h.style.right = '0', h.style.bottom = '0';
      if (corner === 'sw') h.style.left = '0', h.style.bottom = '0';
      var dotCursor = corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize';
      h.style.cursor = dotCursor;
      root.appendChild(h);
    });
    document.documentElement.appendChild(root);
    frame = { root: root, badge: badge };
    return root;
  }

  function placeFrame(rect) {
    var root = frameRoot();
    root.style.left = rect.left + 'px';
    root.style.top = rect.top + 'px';
    root.style.width = Math.max(1, rect.width) + 'px';
    root.style.height = Math.max(1, rect.height) + 'px';
  }

  function setBadge(text) {
    if (!frame) return;
    frame.badge.hidden = !text;
    frame.badge.textContent = text || '';
  }

  /** Document-order index of `el` among its tag's occurrences in the AUTHORED DOM (body
   *  descendants). The runtime's overlays (cursor, spotlight, subtitle) and this bridge's own
   *  selection frame hang off <html>, not <body> -- counting them made every div patch "drift". */
  function tagIndex(el) {
    var all = document.body.getElementsByTagName(el.tagName);
    var n = 0;
    for (var i = 0; i < all.length; i++) {
      if (all[i] === el) return { index: n, domCount: all.length };
      n++;
    }
    return { index: 0, domCount: all.length };
  }

  function select(el) {
    deselect();
    var selector = '';
    try { selector = window.__anim.selectorOf(el); } catch (err) { selector = ''; }
    sel = {
      el: el,
      selector: selector,
      tag: el.tagName ? el.tagName.toLowerCase() : '',
      baseTransform: el.style.transform || '',
    };
    placeFrame(el.getBoundingClientRect());
    post('selected', {
      selector: selector,
      tag: sel.tag,
      rect: el.getBoundingClientRect().toJSON(),
      position: getComputedStyle(el).position,
    });
  }

  function deselect() {
    sel = null;
    setBadge('');
    if (frame) frame.root.style.display = 'none';
    post('deselected');
  }

  function showFrameIfSelected() {
    if (!sel || !manipulating) return;
    frame.root.style.display = '';
    placeFrame(sel.el.getBoundingClientRect());
  }

  // ---- gestures ------------------------------------------------------------------
  var gesture = null; // {kind:'move'|'scale'|'cursor', x0, y0, rect0, ...}

  function targetFromEvent(e) {
    var el = e.target;
    if (!el || !el.getAttribute) return null;
    if (el.getAttribute('data-handle')) return { kind: 'scale', corner: el.getAttribute('data-handle') };
    if (el.getAttribute('data-studio-frame') !== null || (frame && frame.root.contains(el) && !el.getAttribute('data-handle'))) {
      return { kind: 'move' };
    }
    return null;
  }

  function cursorElement() {
    return document.getElementById('anim-cli-cursor');
  }

  function onDown(e) {
    if (!manipulating || picking || gesture) return;
    var from = targetFromEvent(e);
    if (!from) {
      // Grabbing the cursor glyph: it is pointer-events:none, so we hit-test its box ourselves.
      // Alt (Option) + drag only: after a seek the glyph parks ON its target, and a plain click
      // there must select the element, never steal the gesture.
      var cur = cursorElement();
      if (cur && manipMode === 'motion' && e.altKey) {
        var r = cur.getBoundingClientRect();
        var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        var reach = 22;
        if (e.clientX >= cx - reach && e.clientX <= cx + reach && e.clientY >= cy - reach && e.clientY <= cy + reach) {
          gesture = {
            kind: 'cursor', x0: e.clientX, y0: e.clientY,
            baseTx: cursorBase ? cursorBase.x : 0,
            baseTy: cursorBase ? cursorBase.y : 0,
          };
          e.preventDefault(); e.stopPropagation();
          return;
        }
      }
      // A click on the page: select (or reselect) the element; deselect when hitting nothing.
      var el = e.target;
      if (el === document.documentElement || el === document.body || !el || el === (sel && sel.el)) {
        if (el === (sel && sel.el)) return; // clicking the selected element keeps it
        deselect();
      } else {
        select(el);
      }
      return;
    }
    if (!sel) return;
    if (manipMode === 'layout') {
      var camActive = false;
      try { camActive = !!window.__anim.cameraActive(); } catch (err) { camActive = false; }
      if (camActive) {
        post('layout-refused', {
          reason: 'a camera zoom is active at this step \u2014 move boxes from a step where the camera is at scale 1 (or after a pull-back), so the geometry you drag is the geometry that ships',
        });
        return;
      }
    }
    e.preventDefault(); e.stopPropagation();
    var rect = sel.el.getBoundingClientRect();
    if (from.kind === 'move') {
      gesture = { kind: 'move', x0: e.clientX, y0: e.clientY, rect0: rect };
    } else {
      gesture = {
        kind: 'scale', corner: from.corner,
        x0: e.clientX, y0: e.clientY, rect0: rect,
        // The anchor is the OPPOSITE corner: the resize pivots around it.
        ax: /w$/.test(from.corner) ? rect.right : rect.left,
        ay: /^n/.test(from.corner) ? rect.bottom : rect.top,
      };
    }
    setBadge(Math.round(rect.width) + ' \u00d7 ' + Math.round(rect.height));
  }

  function onDrag(e) {
    if (!gesture) {
      showFrameIfSelected();
      return;
    }
    if (e.buttons === 0) {
      // The button was released outside the iframe: end the gesture at the pointer's last
      // known position rather than staying armed for the next stray mouseup.
      onUp(e);
      return;
    }
    e.preventDefault(); e.stopPropagation();
    var dx = e.clientX - gesture.x0;
    var dy = e.clientY - gesture.y0;

    if (gesture.kind === 'cursor') {
      // Feedback: move the glyph itself (overlay px = client px / rootZoom).
      var cur = cursorElement();
      if (cur) {
        var f = cursorFactor();
        cur.style.transition = 'none';
        cur.style.transform = 'translate(' + (gesture.baseTx + dx / f) + 'px, ' + (gesture.baseTy + dy / f) + 'px)';
      }
      return;
    }
    if (!sel) return;

    if (gesture.kind === 'move') {
      if (manipMode === 'motion') {
        sel.el.style.transform = 'translate(' + dx + 'px, ' + dy + 'px) ' + sel.baseTransform;
      } else {
        applyLayoutFeedback(gesture.rect0.left + dx, gesture.rect0.top + dy, gesture.rect0.width, gesture.rect0.height);
      }
      placeFrame({ left: gesture.rect0.left + dx, top: gesture.rect0.top + dy, width: gesture.rect0.width, height: gesture.rect0.height });
    } else if (gesture.kind === 'scale') {
      var w = Math.abs(e.clientX - gesture.ax);
      var h = Math.abs(e.clientY - gesture.ay);
      var w0 = Math.abs(gesture.rect0.left + gesture.rect0.width - gesture.ax) || 1;
      var ratio = Math.max(0.05, Math.min(20, w / w0));
      if (manipMode === 'motion') {
        sel.el.style.transform = sel.baseTransform + ' scale(' + ratio + ')';
      } else {
        var cx = gesture.rect0.left + gesture.rect0.width / 2;
        var cy = gesture.rect0.top + gesture.rect0.height / 2;
        applyLayoutFeedback(cx - (gesture.rect0.width * ratio) / 2, cy - (gesture.rect0.height * ratio) / 2, gesture.rect0.width * ratio, gesture.rect0.height * ratio);
      }
      var newW = gesture.rect0.width * ratio, newH = gesture.rect0.height * ratio;
      placeFrame({ left: cx - newW / 2, top: cy - newH / 2, width: newW, height: newH });
      setBadge(Math.round(newW) + ' \u00d7 ' + Math.round(newH) + (manipMode === 'motion' ? ' \u00b7 \u00d7' + ratio.toFixed(2) : ''));
    }
  }

  function onUp(e) {
    if (!gesture) return;
    var dx = e.clientX - gesture.x0;
    var dy = e.clientY - gesture.y0;
    var kind = gesture.kind;
    var g = gesture;
    gesture = null;

    if (kind === 'cursor') {
      // Restore the glyph: the editor writes xOffset/yOffset, the reload re-places it.
      var cur = cursorElement();
      if (cur) {
        cur.style.transition = '';
        cur.style.transform = 'translate(' + g.baseTx + 'px, ' + g.baseTy + 'px)';
      }
      var cf = cursorFactor();
      post('cursor-dragged', { dx: Math.round(dx / cf), dy: Math.round(dy / cf) });
      setBadge('');
      return;
    }
    if (!sel) return;

    // Restore the element's authored inline state; the commit is data, not DOM.
    sel.el.style.transform = sel.baseTransform;
    if (manipMode === 'motion') {
      var af = authoredFactor();
      if (kind === 'move') {
        post('dragged', { selector: sel.selector, dx: Math.round(dx / af), dy: Math.round(dy / af) });
      } else {
        var w = Math.abs(e.clientX - g.ax);
        var w0 = Math.abs(g.rect0.left + g.rect0.width - g.ax) || 1;
        var ratio = Math.max(0.05, Math.min(20, w / w0));
        post('resized', { selector: sel.selector, scale: Math.round(ratio * 1000) / 1000 });
      }
    } else {
      var rect = sel.el.getBoundingClientRect();
      var af2 = authoredFactor();
      var ti = tagIndex(sel.el);
      post('layout', {
        tag: sel.tag,
        index: ti.index,
        domCount: ti.domCount,
        patch: {
          left: Math.round(rect.left / af2) + 'px',
          top: Math.round(rect.top / af2) + 'px',
          width: Math.round(rect.width / af2) + 'px',
          height: Math.round(rect.height / af2) + 'px',
        },
        position: getComputedStyle(sel.el).position,
      });
    }
    setBadge('');
    showFrameIfSelected();
  }

  /** Layout-mode live feedback: absolute/fixed geometry via inline styles; flow refuses. */
  function applyLayoutFeedback(left, top, width, height) {
    var pos = getComputedStyle(sel.el).position;
    if (pos !== 'absolute' && pos !== 'fixed') {
      if (!gesture || !gesture.refused) {
        if (gesture) gesture.refused = true;
        post('layout-refused', {
          reason: '"' + (sel.el.tagName || '').toLowerCase() + '" is in the document flow (' + pos + ') -- only absolutely or fixed positioned boxes can be moved here; edit index.html directly for flow elements',
        });
      }
      return;
    }
    if (!gesture || !gesture.geom) {
      if (gesture) gesture.geom = {
        left: sel.el.style.left, top: sel.el.style.top,
        width: sel.el.style.width, height: sel.el.style.height,
      };
    }
    sel.el.style.left = Math.round(left) + 'px';
    sel.el.style.top = Math.round(top) + 'px';
    sel.el.style.width = Math.round(width) + 'px';
    sel.el.style.height = Math.round(height) + 'px';
  }

  // Capture the cursor glyph's current translate before a cursor grab can start.
  document.addEventListener('mousedown', function (e) {
    if (!manipulating || gesture) return;
    var cur = cursorElement();
    if (cur) {
      var m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(cur.style.transform || '');
      cursorBase = m ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: 0 };
    } else {
      cursorBase = null;
    }
    onDown(e);
  }, true);
  var cursorBase = null;

  document.addEventListener('mousemove', function (e) { if (manipulating && !picking) onDrag(e); }, true);
  document.addEventListener('mouseup', function (e) { if (gesture) onUp(e); }, true);
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onPickClick, true);
  document.addEventListener('keydown', onKey, true);

  // The frame must follow window resizes and stay glued to its element.
  window.addEventListener('resize', showFrameIfSelected);

  // ---- messages -------------------------------------------------------------------
  function setManipulate(on, mode) {
    manipulating = !!on;
    if (mode === 'layout' || mode === 'motion') manipMode = mode;
    if (manipulating && !picking) document.documentElement.style.cursor = '';
    if (!manipulating) deselect();
    post('manip-state', { on: manipulating, mode: manipMode });
  }

  window.addEventListener('message', function (e) {
    if (e.source !== parent) return;
    var d = e.data || {};
    if (d.source !== 'anim-studio') return;
    if (d.type === 'reload') {
      // A fresh timeline invalidates any selection (its element was just been rebuilt).
      deselect();
      try {
        window.__anim.stop();
        var restored = window.__anim.restart(); // authored DOM back from the boot snapshot
        window.__anim.start(0);
        window.__tour.boot({ steps: d.steps || [], meta: d.meta || {} }); // posts a fresh 'ready'
        if (!restored) post('reload-failed', { message: 'no boot snapshot to restore' });
      } catch (err) {
        post('reload-failed', { message: String((err && err.message) || err) });
      }
    } else if (d.type === 'pick') {
      setPick(!!d.enable);
    } else if (d.type === 'manipulate') {
      setManipulate(d.enable, d.mode);
    }
  });

  window.__studio = {
    version: 2,
    selectElement: function (el) { select(el); },
    state: function () { return { manipulating: manipulating, mode: manipMode, picking: picking, selected: !!sel }; },
  };
})();
