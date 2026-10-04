// Demoforge studio -- the editor over anim.config.json. A view, never a second source of truth:
// the file's JSON is the state; the studio holds a dirty in-memory copy, saves are explicit, and
// unknown fields (the schema is open) round-trip untouched. The preview is the mockup as a
// tour-style page in an iframe: transport speaks the unchanged 'anim-tour' protocol, and the two
// editor extensions ('reload', 'pick') speak 'anim-studio' via the injected studio-bridge.
(function () {
  'use strict';

  // ---------------------------------------------------------------- constants
  // Names mirror schema.EASING_NAMES / runtime.EASINGS (test/constants.test.ts asserts that pair);
  // the bezier strings mirror runtime.EASINGS so the picker's preview runs the real curve.
  var EASINGS = {
    linear: 'linear',
    easeInCubic: 'cubic-bezier(0.32, 0, 0.67, 0)',
    easeOutCubic: 'cubic-bezier(0.33, 1, 0.68, 1)',
    easeInOutCubic: 'cubic-bezier(0.65, 0, 0.35, 1)',
    easeOutBack: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    easeOutExpo: 'cubic-bezier(0.16, 1, 0.3, 1)',
    spring: 'cubic-bezier(0.22, 1.61, 0.36, 1)'
  };

  var ACTIONS = ['wait', 'click', 'focus', 'type', 'highlight', 'hover', 'camera', 'scroll', 'fadeIn', 'transitionScreen', 'navigate', 'press', 'animate'];
  var SUBTITLE_PLACES = ['bottom', 'top', 'bottom-left', 'bottom-right', 'top-left', 'top-right'];

  // The inspector's vocabulary. This registry is the drift guard: a schema field it does not know
  // still round-trips (the Raw tab edits the whole step), it just gets no widget.
  var F_IDENTITY = [
    { k: 'id', type: 'text', help: 'stable identity -- strings keys and guide frames attach to it, not position' },
    { k: 'time', type: 'text', help: 'the interaction moment: "2s", "2500ms" or seconds as a number' }
  ];
  var F_TEXT = [
    { k: 'title', type: 'text', help: 'the guide heading and chapter name' },
    { k: 'subtitle', type: 'text', help: 'the video subtitle bar; also the narration when none is set' },
    { k: 'subtitlePlace', type: 'select', options: SUBTITLE_PLACES, help: 'pins the cue, taking it out of the automatic dodge' },
    { k: 'narration', type: 'text' },
    { k: 'note', type: 'text', help: 'extra sentence under the step in the guide' }
  ];
  var CURSOR_NUDGE = [
    { k: 'xOffset', type: 'number', step: 1, help: 'nudge the cursor off the target centre (drag the cursor in the preview)' },
    { k: 'yOffset', type: 'number', step: 1 }
  ];
  var F_ACTION = {
    wait: [],
    click: [{ k: 'target', type: 'target' }].concat(CURSOR_NUDGE),
    focus: [{ k: 'target', type: 'target' }].concat(CURSOR_NUDGE),
    type: [{ k: 'target', type: 'target' }, { k: 'value', type: 'text', help: 'typed text' }, { k: 'cps', type: 'number', min: 1, step: 1, help: 'characters per second (default 25)' }].concat(CURSOR_NUDGE),
    highlight: [{ k: 'target', type: 'target' }].concat(CURSOR_NUDGE),
    hover: [{ k: 'target', type: 'target' }].concat(CURSOR_NUDGE),
    scroll: [{ k: 'target', type: 'target' }],
    fadeIn: [{ k: 'target', type: 'target' }, { k: 'duration', type: 'number', min: 0, step: 0.1, help: 'seconds (default: the CSS transition, else 0.8)' }],
    transitionScreen: [{ k: 'target', type: 'target' }, { k: 'duration', type: 'number', min: 0, step: 0.1 }],
    navigate: [{ k: 'url', type: 'text', help: 'live pages only' }],
    press: [{ k: 'value', type: 'text', help: 'key name: Enter, Tab, Control+K' }],
    camera: [
      { k: 'target', type: 'target' },
      { k: 'scale', type: 'number', step: 0.01, help: 'zoom factor (1 = pan without zoom)' },
      { k: 'duration', type: 'number', min: 0, step: 0.1, help: 'seconds (default 2.5)' },
      { k: 'ease', type: 'easing' },
      { k: 'x', type: 'number', step: 1, help: 'centre on a point instead of a target' },
      { k: 'y', type: 'number', step: 1 },
      { k: 'xOffset', type: 'number', step: 1, help: 'nudge the framing after the centre is solved' },
      { k: 'yOffset', type: 'number', step: 1 }
    ],
    animate: [
      { k: 'target', type: 'target' },
      { k: 'from', type: 'json', help: 'start state: x, y, scale, rotate, opacity, any CSS' },
      { k: 'to', type: 'json', help: 'end state' },
      { k: 'duration', type: 'number', min: 0, step: 0.05, help: 'seconds (default 0.6)' },
      { k: 'ease', type: 'easing' },
      { k: 'all', type: 'checkbox', help: 'animate every match, not just the first' },
      { k: 'stagger', type: 'number', min: 0, step: 0.01, help: 'seconds between elements (with all)' },
      { k: 'count', type: 'number', min: 1, step: 1, help: 'how many elements target matches (length estimate)' }
    ]
  };
  var F_LIVE = [
    { k: 'waitFor', type: 'text', help: 'live pages: selector or ms before the cursor moves' },
    { k: 'waitForTimeoutMs', type: 'number', min: 0, step: 100, help: 'give up after (default 15000)' }
  ];
  var F_CHROME = [
    { k: 'guide', type: 'checkbox', inv: true, help: 'unchecked hides the step from the guide' },
    { k: 'translatable', type: 'checkbox', help: 'value becomes a string key' },
    { k: 'spotlight', type: 'checkbox', help: 'unchecked suppresses the ring for this step' },
    { k: 'ripple', type: 'checkbox', help: 'unchecked suppresses the click ripple' },
    { k: 'captureAt', type: 'select', options: ['interaction', 'completion'], help: 'when the guide frame is taken: at the click, or after the step settles' }
  ];

  // ---------------------------------------------------------------- state
  var S = {
    raw: null,            // the file's JSON verbatim ({meta, steps}), unknown fields intact
    exists: false,
    dir: '', configPath: '',
    selected: -1,         // index into raw.steps
    dirty: false,
    renames: {},          // old id -> new id, sent on save so strings keys follow
    scaffolds: null,
    presets: null,
    playing: false, current: -1, total: 0,
    pickMode: false,
    issues: [],
    bust: 0,
    liveTimer: null,
    showAllFields: false, // the inspector's "all fields" disclosure
    mtimeMs: undefined,   // the file's mtime at load/save, for the last-save-wins guard
    fileRaw: null,        // the file's own text when it failed to parse (whole-file raw mode)
    fit1x: false,         // preview: fit to pane, or authored 1x with scrolling
    previewW: 1280, previewH: 720,
    device: 'desktop',            // the preview resolves for this device (mapping from the server)
    devices: null,                // { desktop: {positions,total}, mobile: {...} } -- authored indices in play order
    viewports: null,              // { desktop: {width,height}, mobile: {...} }
    locale: null, baseLocale: 'en', locales: [],
    stringsMap: null, stringsMtime: undefined, stringsDirty: false,
    manipMode: 'motion',  // direct manipulation: author animate to.x/to.y, or patch index.html
    mockupPatches: {},    // layout-mode patches keyed by tag#index -> {tag, index, domCount, patch}
    mockupDirty: false,
    mockupMtimeMs: undefined,
    selectedInfo: null    // the bridge's last 'selected' report (tag/rect/position)
  };

  var $ = function (id) { return document.getElementById(id); };
  var els = {};
  ['preview', 'steps', 'steps-empty', 'dir', 'kind', 'dirty', 'save', 'check', 'export', 'add-step', 'pick-concept',
    't-prev', 't-play', 't-next', 't-pos', 't-pick', 't-fit', 't-open', 't-note', 't-mode', 't-device', 'locale', 'dirty-screen', 'fields', 'inspector', 'inspector-hint', 'palette', 'raw', 'raw-text', 'raw-apply',
    'issues', 'issues-title', 'issues-list', 'issues-clear', 'concept', 'toasts', 'frame-wrap']
    .forEach(function (id) { els[id] = $(id); });

  function steps() { return Array.isArray(S.raw?.steps) ? S.raw.steps : []; }
  /** The steps the preview should hold: the authored set (base view) or the resolved slice for
   *  the active device, derived from the server's positions map -- drop other-device steps and
   *  merge this device's overrides, the same rules applyDevice enforces. */
  function previewSteps() {
    var authored = steps();
    var m = S.devices && S.devices[S.device];
    var positions = m && m.positions ? m.positions : null;
    if (!positions) return authored;
    var out = authored.filter(function (st, i) { return positions.indexOf(i + 1) !== -1; })
      .map(function (st) {
        var over = st[S.device];
        return (over && typeof over === 'object' && !Array.isArray(over))
          ? Object.assign({}, st, over)
          : Object.assign({}, st);
      });
    if (inTranslation()) {
      out = out.map(function (st) {
        var copy = Object.assign({}, st);
        STRING_FIELDS.forEach(function (f) {
          if (f === 'value' && !st.translatable) return;
          var key = 'steps.' + String(st.id ?? '') + '.' + f;
          if (Object.prototype.hasOwnProperty.call(S.stringsMap, key)) copy[f] = S.stringsMap[key];
        });
        return copy;
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- plumbing
  function postTour(type, extra) {
    var msg = { source: 'anim-tour', type: type };
    if (extra) for (var k in extra) msg[k] = extra[k];
    els.preview.contentWindow.postMessage(msg, location.origin);
  }
  function postStudio(type, extra) {
    var msg = { source: 'anim-studio', type: type };
    if (extra) for (var k in extra) msg[k] = extra[k];
    els.preview.contentWindow.postMessage(msg, location.origin);
  }

  window.addEventListener('message', function (e) {
    if (e.source !== els.preview.contentWindow) return;
    var d = e.data || {};
    if (d.source === 'anim-tour') {
      if (d.type === 'ready') {
        S.total = d.total || 0;
        S.current = -1;
        S.playing = false;
        updateTransport();
        if (S.selected >= 0) {
          var pos = resolvedPos(S.selected);
          if (pos >= 0 && pos < S.total) postTour('goto', { index: pos });
        }
      } else if (d.type === 'state') {
        S.current = authoredAt(d.index); S.playing = !!d.playing;
        updateTransport(); markCurrent();
      } else if (d.type === 'end') {
        S.playing = false; updateTransport();
      }
    } else if (d.source === 'anim-studio') {
      if (d.type === 'picked') {
        setPickMode(false);
        if (S.selected >= 0) {
          setField('target', d.selector);
          toast('target set to ' + (d.selector || '(empty)'), 'good');
        }
      } else if (d.type === 'pick-state') {
        S.pickMode = !!d.on;
        els['t-pick'].classList.toggle('is-on', S.pickMode);
        els['t-pick'].textContent = S.pickMode ? 'Picking\u2026 click an element' : 'Pick target';
      } else if (d.type === 'selected') {
        S.selectedInfo = d;
        if (isAnimateStep()) els['t-note'].textContent = 'drag the element \u00b7 corners scale it';
        else if (isCursorStep()) els['t-note'].textContent = 'Alt-drag the cursor glyph to nudge it off the target';
      } else if (d.type === 'deselected') {
        S.selectedInfo = null;
      } else if (d.type === 'dragged') {
        applyMotionDelta(d.dx, d.dy);
      } else if (d.type === 'resized') {
        applyMotionScale(d.scale);
      } else if (d.type === 'cursor-dragged') {
        applyCursorDelta(d.dx, d.dy);
      } else if (d.type === 'layout') {
        applyLayoutPatch(d);
      } else if (d.type === 'layout-refused') {
        toast(d.reason || 'this element cannot be moved here', 'bad');
      } else if (d.type === 'manip-state') {
        // The bridge echoes the mode; nothing to sync yet beyond the button.
      } else if (d.type === 'reload-failed') {
        // The in-place swap did not take: fall back to a full preview reload from disk.
        if (S.dirty) toast('preview could not hot-swap (' + (d.message || 'unknown') + '); reloading from the last saved file', 'bad');
        reloadPreview();
      }
    }
  });

  function reloadPreview() {
    S.bust++;
    els.preview.src = '/preview?b=' + S.bust + '&device=' + S.device + (S.locale && S.locale !== S.baseLocale ? '&locale=' + encodeURIComponent(S.locale) : '');
  }

  /** The current device's positions, or the identity mapping when resolution is unavailable
   *  (no config yet, or a file that will not parse -- the server sends null, not empty). */
  function effectivePositions() {
    var m = S.devices && S.devices[S.device];
    if (m && m.positions) return m.positions;
    return steps().map(function (st, i) { return i + 1; });
  }

  /** Authored index -> resolved position on the current device (or the nearest survivor). */
  function resolvedPos(authoredIndex) {
    var positions = effectivePositions();
    var at = positions.indexOf(authoredIndex + 1); // authored indices are 1-based in the payload
    if (at !== -1) return at;
    var best = -1, bestDist = Infinity;
    for (var i = 0; i < positions.length; i++) {
      var d = Math.abs(positions[i] - (authoredIndex + 1));
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  }
  /** Resolved position -> authored index (for the playback marker). */
  function authoredAt(resolvedPos_) {
    var positions = effectivePositions();
    var oneBased = positions[resolvedPos_];
    return typeof oneBased === 'number' ? oneBased - 1 : -1;
  }

  function applyViewport() {
    var vp = (S.viewports && S.viewports[S.device]) || { width: 1280, height: 720 };
    S.previewW = vp.width; S.previewH = vp.height;
    sizePreviewFrame();
    fitPreview();
  }

  /** The devices mapping goes stale the moment steps are added, dropped or re-only'd: refresh it
   *  with the timeline payload (the real resolver, server-side) whenever the timeline changes. */
  function refreshMapping() {
    api('GET', '/api/timeline').then(function (r) {
      if (r.status === 200 && r.data) {
        var changed = JSON.stringify(r.data.devices) !== JSON.stringify(S.devices);
        S.devices = r.data.devices || S.devices;
        renderSteps();
        // The reload that triggered this refresh posted steps resolved with the OLD mapping
        // (an `only` flip, a deletion); the corrected list follows the moment it is known.
        if (changed) postStudio('reload', { steps: previewSteps(), meta: S.raw?.meta || {} });
      }
    }).catch(function () { /* mapping degrades to nearest-seek */ });
  }

  function updateDevice() {
    els['t-device'].classList.toggle('is-on', S.device === 'mobile');
    els['t-device'].textContent = S.device === 'mobile' ? 'Mobile' : 'Desktop';
    els['t-device'].title = 'Preview resolves the timeline for ' + S.device
      + (S.device === 'mobile' ? ' (only: mobile steps run, mobile overrides merge; 390x844 unless -w/-H)' : '');
    applyViewport();
    renderSteps();
    reloadPreview();
  }
  els['t-device'].addEventListener('click', function () {
    S.device = S.device === 'desktop' ? 'mobile' : 'desktop';
    updateDevice();
  });

  // ---------------------------------------------------------------- direct manipulation
  function isAnimateStep() {
    if (S.selected < 0) return false;
    var st = steps()[S.selected];
    return !!st && st.action === 'animate';
  }
  function isCursorStep() {
    if (S.selected < 0) return false;
    var a = steps()[S.selected]?.action;
    return a === 'click' || a === 'focus' || a === 'type' || a === 'highlight' || a === 'hover';
  }
  /** Drags write increments onto the step's `to` (the preview showed the to-state already). */
  function applyMotionDelta(dx, dy) {
    if (!isAnimateStep()) {
      toast('select an animate step first \u2014 drags author its motion (to.x/to.y)');
      return;
    }
    var st = steps()[S.selected];
    st.to = Object.assign({}, st.to || {});
    st.to.x = Math.round(((Number(st.to.x) || 0)) + dx);
    st.to.y = Math.round(((Number(st.to.y) || 0)) + dy);
    markDirty();
    renderInspector(); renderRaw();
  }
  function applyMotionScale(ratio) {
    if (!isAnimateStep()) {
      toast('select an animate step first \u2014 corner drags author its scale (to.scale)');
      return;
    }
    var st = steps()[S.selected];
    st.to = Object.assign({}, st.to || {});
    st.to.scale = Math.round(((Number(st.to.scale) || 1) * ratio) * 1000) / 1000;
    markDirty();
    renderInspector(); renderRaw();
  }
  /** The cursor glyph's drag becomes the step's xOffset/yOffset (the runtime's own nudge fields). */
  function applyCursorDelta(dx, dy) {
    if (!isCursorStep()) {
      toast('select a click/type/highlight/hover step first \u2014 the drag nudges its cursor');
      return;
    }
    var st = steps()[S.selected];
    st.xOffset = Math.round((Number(st.xOffset) || 0) + dx);
    st.yOffset = Math.round((Number(st.yOffset) || 0) + dy);
    markDirty();
    renderInspector(); renderRaw();
    toast('cursor nudged \u00b7 xOffset ' + st.xOffset + ', yOffset ' + st.yOffset, 'good');
  }
  /** Layout mode: accumulate inline-style patches for index.html, keyed so repeats overwrite. */
  function applyLayoutPatch(d) {
    if (!d || !d.tag || typeof d.index !== 'number') return;
    S.mockupPatches[d.tag + '#' + d.index] = { tag: d.tag, index: d.index, domCount: d.domCount, patch: d.patch };
    markMockupDirty();
    var keys = Object.keys(S.mockupPatches).length;
    els['t-note'].textContent = 'screen: ' + keys + ' element(s) moved \u2014 Save writes index.html';
  }
  function markMockupDirty() {
    S.mockupDirty = true;
    els['dirty-screen'].hidden = false;
  }
  function updateManipMode() {
    els['t-mode'].classList.toggle('is-on', S.manipMode === 'layout');
    els['t-mode'].textContent = S.manipMode === 'layout' ? 'Layout' : 'Motion';
    els['t-mode'].title = S.manipMode === 'layout'
      ? 'Layout mode: drag/resize absolutely-positioned boxes -- Save patches index.html'
      : 'Motion mode: drags author the selected animate step (to.x/to.y/to.scale); Alt-drag the cursor to nudge it';
    if (S.selected >= 0) postStudio('manipulate', { enable: true, mode: S.manipMode });
  }
  els['t-mode'].addEventListener('click', function () {
    S.manipMode = S.manipMode === 'motion' ? 'layout' : 'motion';
    updateManipMode();
    toast(S.manipMode === 'layout'
      ? 'Layout mode \u2014 moving boxes edits the screen itself (index.html, absolute/fixed elements)'
      : 'Motion mode \u2014 drags author the selected animate step', 'good');
  });

  function setPickMode(on) {
    if (on === S.pickMode) return;
    postStudio('pick', { enable: !!on });
    // If the bridge never answers (very old page), reset locally anyway.
    setTimeout(function () {
      if (on && !S.pickMode) { S.pickMode = false; }
    }, 300);
  }

  // ---------------------------------------------------------------- fetch
  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.json().then(function (data) { return { status: res.status, data: data }; });
    });
  }

  function boot() {
    Promise.all([api('GET', '/api/timeline'), fetch('presets.json').then(function (r) { return r.json(); })])
      .then(function (r) {
        var t = r[0].data;
        S.presets = r[1];
        S.dir = t.dir; S.configPath = t.configPath; S.exists = t.exists; S.raw = t.raw;
        S.mtimeMs = t.mtimeMs;
        if (typeof t.mockupMtimeMs === 'number') S.mockupMtimeMs = t.mockupMtimeMs;
        S.previewW = (t.preview && t.preview.width) || 1280;
        S.previewH = (t.preview && t.preview.height) || 720;
        S.viewports = t.viewports || null;
        S.devices = t.devices || null;
        S.baseLocale = t.baseLocale || 'en';
        S.locales = t.locales || [];
        if (t.initialDevice === 'mobile') S.device = 'mobile';
        applyViewport();
        renderLocaleSwitcher();
        // A file that will not parse is the moment the editor is most useful: say it, and offer
        // the whole-file raw surface (the per-step Raw tab has nothing to show with zero steps).
        if (S.raw && S.raw.__parseError) {
          S.fileRaw = t.rawText ?? '';
          setIssues([{ level: 'error', message: 'the file is not valid JSON \u2014 ' + S.raw.__parseError + '. The Raw tab holds the whole file; fix it there and Apply.' }], 'The timeline file could not be read');
        }
        els.dir.textContent = S.configPath;
        els.dir.title = S.configPath;
        renderAll();
        if (!S.exists) showConcept();
        // "no steps" from the empty parse-error shell is noise beside the real diagnosis.
        if (!S.fileRaw && t.issues && t.issues.length) setIssues(t.issues.map(function (m) { return { level: 'warning', message: m, step: null }; }), 'Loaded with warnings');
        fitPreview();
      })
      .catch(function (e) { toast('could not load the timeline: ' + e, 'bad'); });
    window.addEventListener('resize', fitPreview);
  }

  // ---------------------------------------------------------------- render
  function renderAll() {
    renderKind();
    renderSteps();
    renderInspector();
    renderPalette();
    updateTransport();
    updateDirty();
  }

  function renderKind() {
    var kind = (S.raw?.meta?.kind === 'reel') ? 'reel' : 'guide';
    els.kind.hidden = !S.exists;
    els.kind.textContent = kind;
  }

  function renderSteps() {
    var list = steps();
    els['steps-empty'].hidden = !(list.length === 0);
    els.steps.innerHTML = '';
    list.forEach(function (st, i) {
      var row = document.createElement('div');
      row.className = 'step' + (i === S.selected ? ' is-selected' : '') + (i === S.current ? ' is-current' : '');
      row.setAttribute('data-i', i);
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      // An accessible name a human can parse, not the concatenated default.
      row.setAttribute('aria-label', [st.time, st.action, st.id, st.title || st.target || ''].filter(Boolean).join(' \u00b7 '));

      var time = document.createElement('span');
      time.className = 'time';
      time.textContent = String(st.time ?? '?');

      var act = document.createElement('span');
      act.className = 'act';
      act.textContent = String(st.action ?? '?');

      var meta = document.createElement('span');
      meta.className = 'meta';
      var b = document.createElement('b');
      b.textContent = String(st.id ?? '');
      var it = document.createElement('i');
      it.textContent = String(st.title || st.target || st.value || '');
      meta.appendChild(b); meta.appendChild(it);

      var flags = document.createElement('span');
      flags.className = 'flags';
      if (st.guide === false) flags.appendChild(flag('\u25CB', 'hidden from the guide'));
      if (st.only) flags.appendChild(flag(String(st.only), 'device only'));
      var dm = S.devices && S.devices[S.device];
      if (dm && dm.positions) {
        var onDevice = dm.positions.indexOf(i + 1) !== -1;
        if (!onDevice) flags.appendChild(flag('\u2298', 'not played on ' + S.device + ' (only: ' + (st.only || 'other') + ')'));
      }
      if (st.mobile && typeof st.mobile === 'object') flags.appendChild(flag('mob', 'carries a mobile override'));
      if (st.desktop && typeof st.desktop === 'object') flags.appendChild(flag('dsk', 'carries a desktop override'));
      if (S.locale && S.locale !== S.baseLocale && stepUntranslated(st)) flags.appendChild(flag('\u00B7' + S.locale, 'untranslated step in ' + S.locale));

      var ops = document.createElement('span');
      ops.className = 'ops';
      [['\u2191', 'Move up', function () { moveStep(i, -1); }],
       ['\u2193', 'Move down', function () { moveStep(i, 1); }],
       ['\u2295', 'Duplicate', function () { dupStep(i); }],
       ['\u2715', 'Delete', function () { delStep(i); }]].forEach(function (op) {
        var btn = document.createElement('button');
        btn.type = 'button'; btn.textContent = op[0]; btn.title = op[1];
        btn.setAttribute('aria-label', op[1] + ' step ' + (i + 1));
        btn.addEventListener('click', function (ev) { ev.stopPropagation(); op[2](); });
        ops.appendChild(btn);
      });

      row.appendChild(time); row.appendChild(act); row.appendChild(meta); row.appendChild(flags); row.appendChild(ops);
      function pick() { select(i); }
      row.addEventListener('click', pick);
      row.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') {
          // stopPropagation: the document-level transport keys must not also fire (Space on a
          // row would otherwise select AND toggle playback).
          ev.preventDefault(); ev.stopPropagation(); pick();
        }
      });
      els.steps.appendChild(row);
    });
  }
  function flag(text, title) {
    var s = document.createElement('span');
    s.textContent = text; s.title = title;
    return s;
  }

  function markCurrent() {
    Array.prototype.forEach.call(els.steps.children, function (row) {
      row.classList.toggle('is-current', Number(row.getAttribute('data-i')) === S.current);
    });
  }

  function select(i, seek) {
    S.selected = i;
    renderSteps();
    renderInspector();
    renderRaw();
    postStudio('manipulate', { enable: S.selected >= 0, mode: S.manipMode });
    if (seek !== false && S.total > 0) {
      var pos = resolvedPos(i);
      if (pos >= 0) postTour('goto', { index: pos });
    }
  }

  // ---------------------------------------------------------------- inspector
  /** Every control gets a real label[for] and an id, so a screen reader names the field; help text
   *  is visible (not hover-only); JSON fields say WHY they are bad, not just red. */
  function fieldRow(f, step) {
    var wrap = document.createElement('div');
    wrap.className = 'field';
    var has = Object.prototype.hasOwnProperty.call(step, f.k);
    var value = step[f.k];
    var fid = 'f-' + f.k;

    if (f.type === 'checkbox') {
      wrap.classList.add('check');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = fid;
      cb.checked = f.inv ? has ? !value : true : !!value;
      cb.addEventListener('change', function () {
        var v = f.inv ? !cb.checked : cb.checked;
        if (f.inv && v === true) deleteField(f.k); else setField(f.k, v);
      });
      var lb = document.createElement('label');
      lb.setAttribute('for', cb.id);
      var nm0 = document.createElement('span'); nm0.className = 'fname'; nm0.textContent = f.k;
      lb.appendChild(nm0);
      wrap.appendChild(cb); wrap.appendChild(lb);
      appendHint(wrap, f);
      return wrap;
    }

    var lab = document.createElement('label');
    lab.setAttribute('for', fid);
    var nm = document.createElement('span'); nm.className = 'fname'; nm.textContent = f.k;
    lab.appendChild(nm);
    wrap.appendChild(lab);

    var input;
    if (f.type === 'select' || f.type === 'easing') {
      input = document.createElement('select');
      input.id = fid;
      var blank = document.createElement('option');
      blank.value = ''; blank.textContent = '\u2014';
      input.appendChild(blank);
      (f.type === 'easing' ? Object.keys(EASINGS) : f.options).forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = o; opt.textContent = o;
        input.appendChild(opt);
      });
      input.value = value === undefined ? '' : String(value);
      input.addEventListener('change', function () {
        if (input.value === '') deleteField(f.k); else setField(f.k, input.value);
      });
    } else if (f.type === 'json') {
      input = document.createElement('textarea');
      input.id = fid;
      input.value = value === undefined ? '' : JSON.stringify(value);
      input.spellcheck = false;
      input.setAttribute('aria-invalid', 'false');
      input.addEventListener('change', function () {
        var text = input.value.trim();
        if (text === '') { setBad(wrap, input, null); deleteField(f.k); return; }
        try {
          setField(f.k, JSON.parse(text));
          setBad(wrap, input, false);
        } catch (err) {
          setBad(wrap, input, true);
        }
      });
    } else {
      input = document.createElement('input');
      input.id = fid;
      input.type = f.type === 'number' ? 'number' : 'text';
      if (f.min !== undefined) input.min = String(f.min);
      if (f.step !== undefined) input.step = String(f.step);
      var trans = inTranslation() && STRING_FIELDS.indexOf(f.k) !== -1 && !(f.k === 'value' && !step.translatable);
      if (trans) {
        // Translation mode: the field shows the locale's entry (or the base inline as the
        // placeholder of the fallback) and writes the strings file, never the inline text.
        var key = stringKeyFor(step, f.k);
        var entry = Object.prototype.hasOwnProperty.call(S.stringsMap, key) ? S.stringsMap[key] : '';
        input.value = entry;
        input.placeholder = String(value ?? '');
        input.classList.add('is-translation');
        input.addEventListener('input', function () {
          if (input.value === '') delete S.stringsMap[key];
          else S.stringsMap[key] = input.value;
          S.stringsDirty = true;
          renderSteps(); // the untranslated chip follows
          scheduleLive();
        });
        wrap.appendChild(input);
        appendHint(wrap, f);
        return wrap;
      }
      input.value = value === undefined ? '' : String(value);
      if (f.type === 'target') input.placeholder = 'CSS selector \u2014 or use Pick target';
      // Numbers commit on input too (not only blur): the live hot-swap below should not wait
      // for the author to click away before the preview reflects a new scale.
      input.addEventListener('input', function () {
        var v = input.value;
        if (v === '') { deleteField(f.k); return; }
        if (f.type === 'number') {
          var n = Number(v);
          if (!Number.isFinite(n)) return;
          setField(f.k, n);
        } else {
          setField(f.k, v);
        }
      });
    }
    wrap.appendChild(input);
    appendHint(wrap, f);
    return wrap;
  }
  function appendHint(wrap, f) {
    if (!f.help) return;
    var h = document.createElement('span');
    h.className = 'fhint';
    h.textContent = f.help;
    wrap.appendChild(h);
  }
  function setBad(wrap, input, bad) {
    wrap.classList.toggle('is-bad', bad === true);
    input.setAttribute('aria-invalid', bad === true ? 'true' : 'false');
    var err = wrap.querySelector('.ferr');
    if (bad === true && !err) {
      err = document.createElement('span');
      err.className = 'ferr';
      err.textContent = 'not valid JSON \u2014 the value was NOT applied';
      wrap.appendChild(err);
    }
  }

  function groupHead(title) {
    var h = document.createElement('div');
    h.className = 'group-head';
    h.textContent = title;
    return h;
  }

  /** Minimal + disclosure: the evergreen fields and the selected action's fields are always
   *  visible (plus any registry field this step has set); everything else waits behind one
   *  "all fields" toggle. A 23-field wall scans badly; the rare fields cost a click, not the
   *  evergreen ones' attention. */
  function renderInspector() {
    var list = steps();
    els['inspector-hint'].hidden = S.selected >= 0;
    els.fields.innerHTML = '';
    if (S.selected < 0 || S.selected >= list.length) return;
    var step = list[S.selected];

    els.fields.appendChild(groupHead('identity'));
    F_IDENTITY.forEach(function (f) { els.fields.appendChild(fieldRow(f, step)); });
    els.fields.appendChild(fieldRow({ k: 'only', type: 'select', options: ['desktop', 'mobile'], help: 'play this step on one device only (the other device drops it)' }, step));

    var actionRow = fieldRow({ k: 'action', type: 'select', options: ACTIONS }, step);
    els.fields.appendChild(actionRow);

    els.fields.appendChild(groupHead(String(step.action || 'step')));
    var actionFields = F_ACTION[step.action] || [{ k: 'target', type: 'target' }];
    actionFields.forEach(function (f) { els.fields.appendChild(fieldRow(f, step)); });
    // `target` outside its own registry entry (wait steps can still carry one).
    if (step.action === 'wait' && hasValue(step, 'target')) {
      els.fields.appendChild(fieldRow({ k: 'target', type: 'target' }, step));
    }

    // Device overrides: raw JSON per device with the same merge discipline as the raw tab.
    var hasOverride = (step.mobile && typeof step.mobile === 'object') || (step.desktop && typeof step.desktop === 'object');
    if (hasOverride || S.showAllFields) {
      els.fields.appendChild(groupHead('device overrides'));
      ['mobile', 'desktop'].forEach(function (dev) {
        els.fields.appendChild(deviceOverrideRow(step, dev));
      });
      var quick = document.createElement('button');
      quick.type = 'button';
      quick.className = 'disclosure';
      quick.textContent = '+ retime on mobile (a time override is the common case)';
      quick.addEventListener('click', function () {
        var over = Object.assign({}, step.mobile || {});
        over.time = step.time;
        setField('mobile', over);
      });
      els.fields.appendChild(quick);
    }

    var registry = [].concat(F_TEXT, F_CHROME, F_LIVE);
    var setFields = registry.filter(function (f) { return hasValue(step, f.k); });
    var restFields = registry.filter(function (f) { return !hasValue(step, f.k); });

    if (setFields.length) {
      els.fields.appendChild(groupHead('set on this step'));
      setFields.forEach(function (f) { els.fields.appendChild(fieldRow(f, step)); });
    }

    if (S.showAllFields || restFields.length === 0) {
      if (restFields.length) {
        els.fields.appendChild(groupHead('all fields'));
        restFields.forEach(function (f) { els.fields.appendChild(fieldRow(f, step)); });
      }
    } else {
      var more = document.createElement('button');
      more.type = 'button';
      more.className = 'disclosure';
      more.textContent = '+ all fields (' + restFields.length + ' hidden \u2014 text, guide appearance, live pages)';
      more.addEventListener('click', function () {
        S.showAllFields = true;
        renderInspector();
      });
      els.fields.appendChild(more);
    }
  }
  function hasValue(step, k) {
    return step[k] !== undefined && step[k] !== false && step[k] !== '';
  }

  /** One device's override object as a JSON block (the raw tab's discipline, scoped). */
  function deviceOverrideRow(step, dev) {
    var wrap = document.createElement('div');
    wrap.className = 'field';
    var fid = 'f-ov-' + dev;
    var lab = document.createElement('label');
    lab.setAttribute('for', fid);
    var nm = document.createElement('span');
    nm.className = 'fname';
    nm.textContent = dev + ' override';
    lab.appendChild(nm);
    var ta = document.createElement('textarea');
    ta.id = fid;
    ta.spellcheck = false;
    ta.value = step[dev] === undefined ? '' : JSON.stringify(step[dev]);
    ta.addEventListener('change', function () {
      var text = ta.value.trim();
      if (text === '') { setBad(wrap, ta, null); deleteField(dev); return; }
      try {
        var parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        setField(dev, parsed);
        setBad(wrap, ta, false);
      } catch (err) {
        setBad(wrap, ta, true);
      }
    });
    wrap.appendChild(lab);
    wrap.appendChild(ta);
    var h = document.createElement('span');
    h.className = 'fhint';
    h.textContent = 'shallow-merged into the step when rendering ' + dev + ' (time, target, duration, stagger, ease, ...) \u2014 remove with an empty value';
    wrap.appendChild(h);
    return wrap;
  }

  // ------------------------------------------------------------ locale (translations)
  var STRING_FIELDS = ['title', 'subtitle', 'narration', 'note', 'value'];

  function stringKeyFor(step, field) {
    return 'steps.' + String(step?.id ?? '') + '.' + field;
  }
  function inTranslation() {
    return !!S.locale && S.locale !== S.baseLocale && S.stringsMap !== null;
  }
  /** A step is untranslated when any non-empty inline string field lacks a strings entry. */
  function stepUntranslated(step) {
    if (!inTranslation()) return false;
    return STRING_FIELDS.some(function (f) {
      if (f === 'value' && !step.translatable) return false;
      var inline = step[f];
      if (inline === undefined || inline === '' || typeof inline !== 'string') return false;
      var key = stringKeyFor(step, f);
      return !Object.prototype.hasOwnProperty.call(S.stringsMap, key);
    });
  }
  function untranslatedCount() {
    return steps().filter(stepUntranslated).length;
  }

  function loadStrings(locale) {
    if (S.stringsDirty && inTranslation() && locale !== S.locale) {
      // Switching away would orphan edits that exist only in S.stringsMap.
      if (!window.confirm('Unsaved ' + S.locale + ' translations. Save them before switching? (Cancel stays on ' + S.locale + ')')) {
        renderLocaleSwitcher();
        return Promise.resolve(false);
      }
      return saveStrings().then(function (ok) { return ok ? loadStrings(locale) : (renderLocaleSwitcher(), false); });
    }
    if (!locale || locale === S.baseLocale) {
      S.locale = locale || S.baseLocale;
      S.stringsMap = null;
      renderSteps(); renderInspector();
      reloadPreview();
      summarizeTranslations();
      return Promise.resolve(true);
    }
    return api('GET', '/api/strings?locale=' + encodeURIComponent(locale)).then(function (r) {
      if (r.status !== 200) { toast('could not load strings.' + locale + ': ' + (r.data?.error || r.status), 'bad'); return false; }
      S.locale = locale;
      S.stringsMap = r.data.map || {};
      S.stringsMtime = r.data.mtimeMs;
      renderSteps(); renderInspector();
      reloadPreview();
      summarizeTranslations();
      return true;
    });
  }

  function summarizeTranslations() {
    if (!inTranslation()) return;
    var n = untranslatedCount();
    if (n) setIssues([{ level: 'info', message: n + ' step(s) have missing translations in ' + S.locale + ' -- the preview falls back to their base text; type into their fields to translate', step: null }], 'Editing ' + S.locale + ' translations');
    else setIssues([], 'Editing ' + S.locale + ' translations \u00b7 everything translated');
  }

  function renderLocaleSwitcher() {
    var sel = els.locale;
    sel.innerHTML = '';
    var codes = [S.baseLocale].concat(S.locales.filter(function (c) { return c !== S.baseLocale; }));
    codes.forEach(function (code) {
      var opt = document.createElement('option');
      opt.value = code;
      opt.textContent = code === S.baseLocale ? code + ' (base)' : code;
      sel.appendChild(opt);
    });
    var add = document.createElement('option');
    add.value = '__new__';
    add.textContent = '+ new locale\u2026';
    sel.appendChild(add);
    sel.value = S.locale || S.baseLocale;
  }
  els.locale.addEventListener('change', function () {
    var v = els.locale.value;
    if (v === '__new__') {
      var code = window.prompt('Locale code (e.g. fr, pt-BR):', '');
      if (!code || !/^[\w-]{2,16}$/.test(code)) {
        toast('not a locale code'); renderLocaleSwitcher(); return;
      }
      // Scaffold the same shape `localize` writes: pre-filled with the source text.
      var prefill = {};
      steps().forEach(function (st) {
        STRING_FIELDS.forEach(function (f) {
          if (f === 'value' && !st.translatable) return;
          if (typeof st[f] === 'string' && st[f]) prefill[stringKeyFor(st, f)] = st[f];
        });
      });
      if (S.raw?.meta?.title) prefill['meta.title'] = String(S.raw.meta.title);
      // The server validates keys against the file on disk; save first so unsaved ids exist there.
      (S.dirty ? saveTimeline() : Promise.resolve(true)).then(function (saved) {
        if (!saved) { renderLocaleSwitcher(); return; }
        return api('PUT', '/api/strings', { locale: code, map: prefill }).then(function (r) {
        if (r.status !== 200) { toast('could not create strings.' + code + ': ' + (r.data?.error || r.status), 'bad'); renderLocaleSwitcher(); return; }
        S.locales.push(code);
        S.stringsMtime = r.data.mtimeMs;
        toast('strings.' + code + '.json scaffolded with the source text \u2014 translate the fields, save writes the file', 'good');
        renderLocaleSwitcher();
        loadStrings(code);
        });
      });
      return;
    }
    loadStrings(v);
  });

  // ---------------------------------------------------------------- editing
  function markDirty() {
    S.dirty = true;
    updateDirty();
    scheduleLive();
  }
  function updateDirty() {
    els.dirty.hidden = !S.dirty;
    document.title = (S.dirty ? '\u2022 ' : '') + 'Demoforge studio';
  }

  function setField(k, v) {
    if (S.selected < 0) return;
    var step = steps()[S.selected];
    if (!step) return;
    if (k === 'id' && step.id !== v && step.id) S.renames[String(step.id)] = String(v);
    step[k] = v;
    if (k === 'action') { renderInspector(); renderRaw(); }
    if (k === 'id' || k === 'time' || k === 'action' || k === 'title' || k === 'target') renderSteps();
    markDirty();
  }
  function deleteField(k) {
    if (S.selected < 0) return;
    var step = steps()[S.selected];
    if (!step) return;
    delete step[k];
    if (k === 'id' || k === 'time' || k === 'action') renderSteps();
    markDirty();
  }

  function scheduleLive() {
    if (S.liveTimer) clearTimeout(S.liveTimer);
    S.liveTimer = setTimeout(function () {
      S.liveTimer = null;
      postStudio('reload', { steps: previewSteps(), meta: S.raw?.meta || {} });
      refreshMapping();
    }, 450);
  }

  function suggestedId() {
    var n = 0;
    steps().forEach(function (st) {
      var m = /^step-(\d+)$/.exec(String(st?.id ?? ''));
      if (m) n = Math.max(n, Number(m[1]));
    });
    return 'step-' + String(n + 1).padStart(2, '0');
  }

  function addStep() {
    var list = steps();
    if (!Array.isArray(S.raw.steps)) S.raw.steps = [];
    var at = S.selected >= 0 ? S.selected + 1 : list.length;
    var last = list.length ? list[list.length - 1] : null;
    var step = { id: suggestedId(), time: bumpTime(last?.time ?? 0), action: 'wait' };
    S.raw.steps.splice(at, 0, step);
    markDirty();
    select(at);
    toast('step added as ' + step.id + ' \u2014 give it a real id if a strings file exists', 'good');
  }

  function bumpTime(t) {
    var ms = 0;
    if (typeof t === 'number') ms = t * 1000;
    else {
      var m = /^([\d.]+)\s*(ms|s)?$/i.exec(String(t ?? ''));
      if (m) ms = Number(m[1]) * (String(m[2] || 's').toLowerCase() === 'ms' ? 1 : 1000);
    }
    ms += 1000;
    var secs = ms / 1000;
    return (secs % 1 === 0 ? secs + 's' : secs.toFixed(2) + 's');
  }

  function dupStep(i) {
    var copy = JSON.parse(JSON.stringify(steps()[i]));
    var base = String(copy.id || 'step');
    var n = 2, id = base + '-' + n;
    while (steps().some(function (s) { return s.id === id; })) { n++; id = base + '-' + n; }
    copy.id = id;
    copy.time = bumpTime(copy.time);
    S.raw.steps.splice(i + 1, 0, copy);
    markDirty();
    select(i + 1);
  }

  function delStep(i) {
    var st = steps()[i];
    S.raw.steps.splice(i, 1);
    if (S.selected >= S.raw.steps.length) S.selected = S.raw.steps.length - 1;
    markDirty();
    renderSteps(); renderInspector(); renderRaw();
    toast('deleted ' + (st?.id ?? 'step') + ' \u2014 save to persist; git is the undo');
  }

  function moveStep(i, delta) {
    var j = i + delta;
    var list = steps();
    if (j < 0 || j >= list.length) return;
    var tmp = list[i]; list[i] = list[j]; list[j] = tmp;
    S.selected = j;
    markDirty();
    renderSteps(); renderInspector(); renderRaw();
  }

  // ---------------------------------------------------------------- palette
  function renderPalette() {
    if (!S.presets || els.palette.childElementCount) return;
    function group(title, items, apply) {
      var g = document.createElement('div');
      g.className = 'pal-group';
      var h = document.createElement('h3'); h.textContent = title; g.appendChild(h);
      var grid = document.createElement('div'); grid.className = 'pal-items';
      items.forEach(function (p) {
        var btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'pal-item';
        var b = document.createElement('span'); b.textContent = p.name;
        btn.appendChild(b);
        if (p.note) { var s = document.createElement('small'); s.textContent = p.note; btn.appendChild(s); }
        btn.addEventListener('click', function () { apply(p); });
        grid.appendChild(btn);
      });
      g.appendChild(grid);
      return g;
    }
    els.palette.appendChild(group('Reveals (animate)', S.presets.reveals || [], function (p) { applyFields(p.fields, 'animate'); }));
    els.palette.appendChild(group('Camera moves', S.presets.camera || [], function (p) { applyFields(p.fields, 'camera'); }));
    els.palette.appendChild(group('Screen transitions', S.presets.transitions || [], function (p) { applyFields(p.fields, p.fields.action); }));

    var eg = document.createElement('div');
    eg.className = 'pal-group';
    var eh = document.createElement('h3'); eh.textContent = 'Easings'; eg.appendChild(eh);
    Object.keys(EASINGS).forEach(function (name) {
      var row = document.createElement('button');
      row.type = 'button'; row.className = 'easing-row';
      var label = document.createElement('span'); label.textContent = name;
      var track = document.createElement('span'); track.className = 'ease-track';
      var dot = document.createElement('span'); dot.className = 'ease-dot';
      dot.style.animationTimingFunction = EASINGS[name] === 'linear' ? 'linear' : EASINGS[name];
      track.appendChild(dot);
      row.appendChild(label); row.appendChild(track);
      row.addEventListener('click', function () {
        if (S.selected < 0) { toast('select a step first'); return; }
        var st = steps()[S.selected];
        if (st.action !== 'animate' && st.action !== 'camera') { toast('easings apply to animate and camera steps'); return; }
        setField('ease', name);
        row.classList.add('is-on');
        setTimeout(function () { row.classList.remove('is-on'); }, 900);
      });
      eg.appendChild(row);
    });
    els.palette.appendChild(eg);

    var note = document.createElement('p');
    note.className = 'hint foot';
    note.textContent = 'Presets write plain from/to/ease fields onto the selected step \u2014 the timeline stays ordinary JSON.';
    els.palette.appendChild(note);
  }

  function applyFields(fields, asAction) {
    if (S.selected < 0) { toast('select a step first'); return; }
    var st = steps()[S.selected];
    if (!st) return;
    if (asAction) {
      if (st.action !== asAction && (st.action === 'animate' || st.action === 'camera' || st.action === 'fadeIn' || st.action === 'transitionScreen')) {
        toast('converted the step from ' + st.action + ' to ' + asAction);
      }
      st.action = asAction;
    }
    for (var k in fields) st[k] = fields[k];
    markDirty();
    renderSteps(); renderInspector(); renderRaw();
    select(S.selected);
  }

  // ---------------------------------------------------------------- raw tab
  function renderRaw() {
    // Whole-file mode when the file would not parse (there are no steps to show per-step).
    if (S.fileRaw !== null) {
      els['raw-text'].value = S.fileRaw;
      return;
    }
    if (S.selected < 0) { els['raw-text'].value = ''; return; }
    var st = steps()[S.selected];
    els['raw-text'].value = st ? JSON.stringify(st, null, 2) : '';
  }
  els['raw-apply'].addEventListener('click', function () {
    if (S.fileRaw !== null) {
      // Whole-file mode: parse, adopt, save. The server's mtime guard still watches the disk.
      try {
        var whole = JSON.parse(els['raw-text'].value);
        if (whole === null || typeof whole !== 'object' || Array.isArray(whole)) throw new Error('not a timeline object');
        S.raw = whole;
        markDirty();
        renderAll();
        save();
      } catch (e) {
        toast('still not valid JSON: ' + e.message, 'bad');
      }
      return;
    }
    if (S.selected < 0) return;
    try {
      var parsed = JSON.parse(els['raw-text'].value);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      var oldId = steps()[S.selected]?.id;
      if (oldId && parsed.id && parsed.id !== oldId) S.renames[String(oldId)] = String(parsed.id);
      S.raw.steps[S.selected] = parsed;
      markDirty();
      renderSteps(); renderInspector();
      toast('step JSON applied', 'good');
    } catch (e) {
      toast('invalid JSON: ' + e.message, 'bad');
    }
  });

  // ---------------------------------------------------------------- tabs
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
    tab.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) { t.classList.toggle('is-active', t === tab); });
      ['inspector', 'palette', 'raw'].forEach(function (id) { els[id].hidden = tab.getAttribute('data-tab') !== id; });
      if (tab.getAttribute('data-tab') === 'raw') renderRaw();
    });
  });

  // ---------------------------------------------------------------- transport
  function updateTransport() {
    els['t-play'].innerHTML = S.playing ? '&#10074;&#10074; pause' : '&#9654; play';
    var shown = previewSteps();
    var pos = S.current >= 0 ? resolvedPos(S.current) : -1;
    var at = pos >= 0 && pos < shown.length ? shown[pos] : null;
    els['t-pos'].textContent = S.total
      ? ((pos >= 0 ? pos + 1 : '\u2013') + ' / ' + S.total + (at && at.time !== undefined ? ' \u00b7 ' + at.time : ''))
      : '\u2013';
  }
  els['t-play'].addEventListener('click', function () { postTour(S.playing ? 'pause' : 'play'); });
  els['t-prev'].addEventListener('click', function () { stepBy(-1); });
  els['t-next'].addEventListener('click', function () { stepBy(1); });
  function stepBy(delta) {
    if (S.total <= 0) return;
    // Transport steps in RESOLVED space (the preview's step list), then maps back to authored:
    // adding delta to an authored index walks over dropped steps.
    var positions = effectivePositions();
    var from = S.current >= 0 ? positions.indexOf(S.current + 1) : (S.selected >= 0 ? resolvedPos(S.selected) : 0);
    if (from === -1) from = 0;
    var target = Math.max(0, Math.min(S.total - 1, from + delta));
    postTour('goto', { index: target });
    var auth = authoredAt(target);
    if (auth >= 0) select(auth, false);
  }
  els['t-pick'].addEventListener('click', function () {
    if (S.selected < 0) { toast('select the step whose target you are setting'); return; }
    setPickMode(!S.pickMode);
  });

  // ---------------------------------------------------------------- save / check / export
  function save() {
    if (!S.dirty && !S.mockupDirty && !S.stringsDirty && S.exists) { toast('nothing to save'); return Promise.resolve(true); }
    if (S.dirty || !S.exists) return saveTimeline().then(function (ok) {
      return ok ? saveMockup().then(function (ok2) { return ok2 ? saveStrings() : false; }) : false;
    });
    if (S.mockupDirty) return saveMockup().then(function (ok) { return ok ? saveStrings() : false; });
    return saveStrings();
  }
  function saveTimeline() {
    var renames = Object.keys(S.renames).map(function (from) { return { from: from, to: S.renames[from] }; });
    return api('PUT', '/api/timeline', { raw: S.raw, renames: renames, mtime: S.mtimeMs }).then(function (r) {
      if (r.status === 409) {
        toast('the file changed on disk since this editor loaded it \u2014 nothing was written; reload the page and re-apply your edits', 'bad');
        return false;
      }
      if (r.status === 422) {
        setIssues(r.data.issues || [], 'Save refused \u2014 ' + (r.data.issues || []).length + ' issue(s)');
        toast('the timeline does not validate \u2014 see the footer', 'bad');
        return false;
      }
      if (r.status !== 200 || !r.data.ok) {
        toast('save failed: ' + (r.data?.error || r.status), 'bad');
        return false;
      }
      S.dirty = false; S.renames = {}; S.exists = true; S.fileRaw = null;
      if (typeof r.data.mtimeMs === 'number') S.mtimeMs = r.data.mtimeMs;
      updateDirty(); renderKind();
      var bits = ['saved ' + r.data.path];
      if (r.data.stringsFilesTouched?.length) bits.push('strings keys moved in ' + r.data.stringsFilesTouched.join(', '));
      if (r.data.orphanKeys?.length) bits.push(r.data.orphanKeys.length + ' orphaned strings key(s) \u2014 see the footer');
      toast(bits.join(' \u00b7 ') + ' \u00b7 review in git', 'good');
      if (r.data.orphanKeys?.length) setIssues(r.data.orphanKeys.map(function (k) { return { level: 'warning', message: k, step: null }; }), 'Saved with orphans');
      return true;
    }).catch(function (e) { toast('save failed: ' + e, 'bad'); return false; });
  }
  function saveMockup() {
    if (!S.mockupDirty) return Promise.resolve(true);
    var patches = Object.keys(S.mockupPatches).map(function (k) { return S.mockupPatches[k]; });
    return api('PUT', '/api/mockup', { patches: patches, mtime: S.mockupMtimeMs }).then(function (r) {
      if (r.status !== 200 || !r.data.ok) {
        toast('screen patch refused: ' + (r.data?.error || r.status), 'bad');
        return false;
      }
      S.mockupDirty = false;
      S.mockupPatches = {};
      if (typeof r.data.mtimeMs === 'number') S.mockupMtimeMs = r.data.mtimeMs;
      els['dirty-screen'].hidden = true;
      toast('index.html patched (' + (r.data.applied || patches.length) + ' element(s)) \u00b7 review in git', 'good');
      return true;
    }).catch(function (e) { toast('screen patch failed: ' + e, 'bad'); return false; });
  }
  function saveStrings() {
    if (!S.stringsDirty) return Promise.resolve(true);
    if (!inTranslation()) { S.stringsDirty = false; return Promise.resolve(true); } // defensive: leaving never loses the flag
    return api('PUT', '/api/strings', { locale: S.locale, map: S.stringsMap, mtime: S.stringsMtime }).then(function (r) {
      if (r.status === 409) { toast('strings.' + S.locale + '.json changed on disk -- reload the locale before saving over it', 'bad'); return false; }
      if (r.status !== 200 || !r.data.ok) { toast('translations refused: ' + (r.data?.error || r.status), 'bad'); return false; }
      S.stringsDirty = false;
      S.stringsMtime = r.data.mtimeMs;
      reloadPreview();
      toast('saved ' + r.data.path + ' \u00b7 review in git', 'good');
      summarizeTranslations();
      return true;
    }).catch(function (e) { toast('translations save failed: ' + e, 'bad'); return false; });
  }
  els.save.addEventListener('click', save);

  els.check.addEventListener('click', function () {
    els.check.disabled = true;
    setIssues([], 'Checking\u2026');
    api('POST', '/api/check', { device: S.device, locale: S.locale !== S.baseLocale ? S.locale : undefined }).then(function (r) {
      els.check.disabled = false;
      if (r.status !== 200) { toast('check failed: ' + (r.data?.error || r.status), 'bad'); setIssues([], 'Ready.'); return; }
      var issues = r.data.issues || [];
      var errors = issues.filter(function (i) { return i.level === 'error'; }).length;
      setIssues(issues, 'check: ' + issues.length + ' finding(s), ' + errors + ' error(s)');
      toast(errors ? 'check found ' + errors + ' error(s) \u2014 footer has the list' : 'check is clean' + (issues.length ? ' (' + issues.length + ' note(s))' : ''), errors ? 'bad' : 'good');
    }).catch(function (e) { els.check.disabled = false; toast('check failed: ' + e, 'bad'); });
  });

  els.export.addEventListener('click', function () {
    els.export.disabled = true;
    toast('exporting\u2026 (one browser job at a time)');
    save().then(function (ok) {
      if (!ok) { els.export.disabled = false; return; } // any refused half (timeline OR screen) aborts
      return api('POST', '/api/export', { device: S.device, locale: S.locale !== S.baseLocale ? S.locale : undefined }).then(function (r) {
        els.export.disabled = false;
        if (r.status !== 200) { toast('export failed: ' + (r.data?.error || r.status), 'bad'); return; }
        if (r.data.exitCode !== 0) {
          setIssues([{ level: 'error', message: 'export exited ' + r.data.exitCode, step: null }].concat(tailIssues(r.data.log)), 'Export failed');
          toast('export failed \u2014 log tail in the footer', 'bad');
          return;
        }
        var links = (r.data.artifacts || []).map(function (a) {
          return '<a href="/artifact/' + encodeURIComponent(a) + '" target="_blank" rel="noopener">' + a + '</a>';
        }).join(' \u00b7 ');
        toastHtml('exported: ' + links, 'good');
      });
    }).catch(function (e) { els.export.disabled = false; toast('export failed: ' + e, 'bad'); });
  });
  function tailIssues(log) {
    return String(log || '').split('\n').filter(function (l) { return l.trim(); }).slice(-8)
      .map(function (l) { return { level: 'info', message: l.slice(0, 300), step: null }; });
  }

  // ---------------------------------------------------------------- issues footer
  function setIssues(issues, title) {
    S.issues = issues || [];
    els['issues-title'].textContent = title || 'Ready.';
    els['issues-clear'].hidden = S.issues.length === 0;
    els.issues.classList.toggle('is-empty', S.issues.length === 0);
    els['issues-list'].innerHTML = '';
    S.issues.forEach(function (issue) {
      var row = document.createElement('div');
      row.className = 'issue';
      row.setAttribute('data-level', issue.level || 'info');
      if (issue.step) row.setAttribute('data-step', issue.step);
      var lvl = document.createElement('span'); lvl.className = 'lvl'; lvl.textContent = issue.level || 'info';
      var where = document.createElement('span'); where.className = 'where';
      where.textContent = issue.step ? 'step ' + issue.step : issue.id ? issue.id : '';
      var msg = document.createElement('span'); msg.className = 'msg'; msg.textContent = issue.message;
      row.appendChild(lvl); row.appendChild(where); row.appendChild(msg);
      row.addEventListener('click', function () {
        var n = Number(row.getAttribute('data-step'));
        if (n >= 1 && n <= steps().length) select(n - 1);
      });
      els['issues-list'].appendChild(row);
    });
  }
  els['issues-clear'].addEventListener('click', function () { setIssues([], 'Ready.'); });

  // ---------------------------------------------------------------- concept picker
  function showConcept() { els.concept.hidden = false; }
  els['pick-concept'].addEventListener('click', showConcept);
  Array.prototype.forEach.call(document.querySelectorAll('.choice'), function (btn) {
    btn.addEventListener('click', function () {
      var concept = btn.getAttribute('data-concept');
      var load = concept === 'blank'
        ? Promise.resolve({ meta: { title: 'Untitled demo', locale: 'en' }, steps: [] })
        : api('GET', '/api/scaffolds').then(function (r) {
          return r.data[concept === 'reel' ? 'reel' : 'guide'];
        });
      load.then(function (raw) {
        S.raw = JSON.parse(JSON.stringify(raw));
        S.exists = true; S.dirty = true; S.selected = -1; S.fileRaw = null;
        els.concept.hidden = true;
        renderAll();
        scheduleLive();
        toast('scaffold ready \u2014 save (or \u2318S) writes ' + S.configPath, 'good');
      }).catch(function (e) { toast('could not load the scaffold: ' + e, 'bad'); });
    });
  });

  // ---------------------------------------------------------------- chrome
  els['add-step'].addEventListener('click', addStep);

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    // Space and arrows belong to the platform first: a focused BUTTON, link, select or
    // role=button row must get its native meaning (Space clicks Check; it must not toggle
    // playback). Transport keys apply only when focus is on a pane, the body, or the preview.
    var t = e.target;
    if (!t) return;
    var tag = t.tagName || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A'
      || t.isContentEditable || (t.getAttribute && t.getAttribute('role') === 'button')) return;
    if (e.key === ' ') { e.preventDefault(); postTour(S.playing ? 'pause' : 'play'); }
    else if (e.key === 'ArrowLeft') stepBy(-1);
    else if (e.key === 'ArrowRight') stepBy(1);
  });

  window.addEventListener('beforeunload', function (e) {
    if (S.dirty || S.mockupDirty || S.stringsDirty) { e.preventDefault(); e.returnValue = ''; }
  });

  function fitPreview() {
    var wrap = els['frame-wrap'].getBoundingClientRect();
    var scale = Math.min((wrap.width - 28) / S.previewW, (wrap.height - 28) / S.previewH, 1);
    if (S.fit1x) {
      els.preview.style.transform = 'none';
      els['frame-wrap'].style.overflow = 'auto';
      els['t-note'].textContent = '1\u00d7 authored size \u00b7 scroll to see it all';
    } else {
      els.preview.style.transform = 'scale(' + (scale > 0 ? scale : 1) + ')';
      els['frame-wrap'].style.overflow = 'hidden';
      // Below ~0.35 the preview is decoration, not information (the tour shell's own floor);
      // say so and point at the escapes instead of pretending a thumbnail is a preview.
      els['t-note'].textContent = scale < 0.35
        ? 'fit \u00d7' + scale.toFixed(2) + ' \u2014 too small to read; use Fit (1\u00d7) or open \u2197'
        : 'fit \u00d7' + scale.toFixed(2) + ' \u00b7 authored size ' + S.previewW + '\u00d7' + S.previewH;
    }
    els['t-fit'].classList.toggle('is-on', S.fit1x);
    els['t-fit'].textContent = S.fit1x ? '1\u00d7' : 'Fit';
  }
  els['t-fit'].addEventListener('click', function () {
    S.fit1x = !S.fit1x;
    fitPreview();
  });

  // ---------------------------------------------------------------- toasts
  function toast(text, kind) { toastHtml(escapeHtml(text), kind); }
  function toastHtml(html, kind) {
    var t = document.createElement('div');
    t.className = 'toast' + (kind === 'good' ? ' is-good' : kind === 'bad' ? ' is-bad' : '');
    var body = document.createElement('span');
    body.className = 'toast-body';
    body.innerHTML = html;
    t.appendChild(body);
    els.toasts.appendChild(t);
    setTimeout(function () { t.remove(); }, kind === 'bad' ? 7000 : 4200);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c;
    });
  }

  function sizePreviewFrame() {
    els.preview.style.width = S.previewW + 'px';
    els.preview.style.height = S.previewH + 'px';
  }

  sizePreviewFrame();
  boot();
})();
