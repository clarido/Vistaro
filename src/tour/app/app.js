/**
 * Tour shell. Generic: everything it renders comes from tours.json, and everything it drives goes
 * over the 'anim-tour' postMessage protocol implemented by src/engine/tour-bridge.js. There is no
 * per-product code in here, and adding a scenario means adding a catalog entry, not editing this.
 */
(function () {
  var el = function (id) { return document.getElementById(id); };
  var data = null, current = null, frame = null, ready = false;
  var steps = [], chapters = [], index = -1, playing = false;

  fetch('tours.json')
    .then(function (r) { if (!r.ok) throw new Error('tours.json: HTTP ' + r.status); return r.json(); })
    .then(start)
    .catch(function (e) {
      // Without this the shell sits on its placeholder copy looking merely empty, and the only
      // sign of trouble is an unhandled rejection in a console nobody has open.
      el('cap-title').textContent = 'This tour could not be loaded';
      el('cap-body').textContent = String(e && e.message || e) + ' — the page must be served over http(s), not opened from disk.';
    });

  function start(json) {
    data = json;
    var p = data.product || {};
    if (p.accent) document.documentElement.style.setProperty('--accent', p.accent);
    if (p.name) { el('product-name').textContent = p.name; document.title = p.name + ' — interactive tour'; }
    el('tagline').textContent = p.tagline || '';
    if (data.rail && data.rail.title) el('rail-title').textContent = data.rail.title;
    if (data.rail && data.rail.subtitle) el('rail-sub').textContent = data.rail.subtitle;
    renderRail();
    wireControls();
    var first = fromHash() || data.scenarios[0];
    if (first) select(first, false);          // loaded, paused: the visitor presses play
  }

  function fromHash() {
    var slug = location.hash.replace(/^#/, '');
    return data.scenarios.filter(function (s) { return s.slug === slug; })[0] || null;
  }

  // A hash change is a same-document navigation: shared links and the back button land here, not
  // in start(), so the scenario has to be switched explicitly.
  addEventListener('hashchange', function () {
    var s = fromHash();
    if (s && (!current || s.slug !== current.slug)) select(s, false);
  });

  // ---- rail ----------------------------------------------------------------
  function renderRail() {
    var list = el('rail-list');
    list.textContent = '';
    var groups = (data.groups && data.groups.length) ? data.groups : [{ id: null, label: null }];
    var placed = {};
    groups.forEach(function (g) {
      var mine = data.scenarios.filter(function (s) { return g.id ? s.group === g.id : true; });
      if (!mine.length) return;
      if (g.label) {
        var h = document.createElement('div');
        h.className = 'group-label'; h.textContent = g.label;
        list.appendChild(h);
      }
      mine.forEach(function (s) { placed[s.slug] = true; list.appendChild(card(s)); });
    });
    // Anything the declared groups did not claim still gets a card: a scenario that was built and
    // shipped but is unreachable from the rail is worse than an ungrouped one.
    data.scenarios.filter(function (s) { return !placed[s.slug]; })
      .forEach(function (s) { list.appendChild(card(s)); });
  }

  function card(s) {
    var b = document.createElement('button');
    b.className = 'card'; b.type = 'button'; b.dataset.slug = s.slug;
    var t = document.createElement('div'); t.className = 't';
    var label = document.createElement('span'); label.textContent = s.label;
    t.appendChild(label);
    var meta = null;
    if (s.stepCount) {
      meta = document.createElement('span'); meta.className = 'meta';
      meta.textContent = s.stepCount + ' steps · ' + Math.round((s.durationMs || 0) / 1000) + 's';
    }
    b.appendChild(t);
    if (s.blurb) { var p = document.createElement('div'); p.className = 'b'; p.textContent = s.blurb; b.appendChild(p); }
    if (meta) b.appendChild(meta);
    b.onclick = function () { select(s, true); };
    return b;
  }

  function markActive() {
    [].forEach.call(document.querySelectorAll('.card'), function (c) {
      c.setAttribute('aria-current', String(current && c.dataset.slug === current.slug));
    });
  }

  // ---- scenario loading ----------------------------------------------------
  function select(s, autoplay) {
    current = s; ready = false; steps = []; chapters = []; index = -1; playing = false;
    location.hash = s.slug;
    markActive();
    el('cap-title').textContent = s.label;
    el('cap-body').textContent = s.blurb || '';
    el('eyebrow').textContent = '';
    el('ticks').textContent = '';
    el('count').textContent = '';
    el('veil').hidden = !!autoplay;

    var host = el('screen');
    host.textContent = '';
    host.classList.remove('empty');
    frame = document.createElement('iframe');
    frame.title = s.label;
    frame.setAttribute('scrolling', 'no');
    frame.width = s.viewport.width; frame.height = s.viewport.height;
    frame.style.width = s.viewport.width + 'px';
    frame.style.height = s.viewport.height + 'px';
    frame.src = s.page;
    host.appendChild(frame);
    fit();
    frame.addEventListener('load', function () { if (autoplay) send('play'); });
    syncButtons();
  }

  /** The frame keeps its authored pixel size and is scaled; the well takes the scaled height. */
  function fit() {
    if (!frame || !current) return;
    var host = el('screen');
    var k = host.clientWidth / current.viewport.width;
    frame.style.transform = 'scale(' + k + ')';
    host.style.height = Math.round(current.viewport.height * k) + 'px';
  }
  addEventListener('resize', fit);

  function send(type, extra) {
    if (!frame || !frame.contentWindow) return;
    var msg = { source: 'anim-tour', type: type };
    if (extra) for (var k in extra) msg[k] = extra[k];
    frame.contentWindow.postMessage(msg, '*');
  }

  // ---- messages from the scenario page ------------------------------------
  addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || d.source !== 'anim-tour') return;
    if (!frame || e.source !== frame.contentWindow) return;   // ignore any other frame on the page
    if (d.type === 'ready') { ready = true; steps = d.steps || []; buildTicks(); syncButtons(); }
    else if (d.type === 'state') { index = d.index; playing = d.playing; paint(); }
    else if (d.type === 'end') { playing = false; syncButtons(); }
    else if (d.type === 'error') {
      playing = false;
      el('cap-body').textContent = 'This step could not run: ' + d.message;
      syncButtons();
    }
  });

  /** Ticks track the guide steps; choreography (guide:false, or untitled) rides along unlabelled. */
  function buildTicks() {
    chapters = steps.filter(function (s) { return !s.hidden; });
    var box = el('ticks');
    box.textContent = '';
    chapters.forEach(function (c, n) {
      var t = document.createElement('button');
      t.className = 'tick'; t.type = 'button';
      t.title = (n + 1) + '. ' + c.title;
      t.setAttribute('aria-label', 'Step ' + (n + 1) + ': ' + c.title);
      t.onclick = function () { send('goto', { index: c.index }); };
      box.appendChild(t);
    });
    el('count').textContent = chapters.length ? '0 / ' + chapters.length : '';
  }

  /** The caption shows the most recent labelled step, so a camera move does not blank it. */
  function currentChapter() {
    var found = -1;
    for (var i = 0; i < chapters.length; i++) if (chapters[i].index <= index) found = i;
    return found;
  }

  function paint() {
    var n = currentChapter();
    var c = chapters[n];
    if (c) {
      el('eyebrow').textContent = 'Step ' + (n + 1) + ' of ' + chapters.length;
      el('cap-title').textContent = c.title;
      el('cap-body').textContent = c.subtitle || c.note || '';
    }
    [].forEach.call(el('ticks').children, function (t, k) {
      t.classList.toggle('on', k === n);
      t.classList.toggle('done', k < n);
    });
    el('count').textContent = (n + 1) + ' / ' + chapters.length;
    syncButtons();
  }

  function syncButtons() {
    document.body.classList.toggle('is-playing', playing);
    el('btn-play').textContent = playing ? '❚❚' : '▶';
    el('btn-play').title = playing ? 'Pause' : 'Play';
    el('veil').hidden = playing || index >= 0;
    var none = !ready;
    el('btn-play').disabled = none;
    el('btn-restart').disabled = none;
    var n = currentChapter();
    el('btn-prev').disabled = none || n <= 0;
    el('btn-next').disabled = none || n >= chapters.length - 1;
  }

  /**
   * Move by a labelled step, not by a raw timeline index: the ticks, the caption and the counter all
   * count chapters, so index +/- 1 could land on hidden choreography and look like a dead button.
   */
  function step(delta) {
    var c = chapters[currentChapter() + delta];
    if (c) send('goto', { index: c.index });
  }

  function wireControls() {
    el('btn-play').onclick = function () { send(playing ? 'pause' : 'play'); };
    el('play-big').onclick = function () { send('play'); };
    el('btn-next').onclick = function () { step(1); };
    el('btn-prev').onclick = function () { step(-1); };
    el('btn-restart').onclick = function () { send('restart'); };
    addEventListener('keydown', function (e) {
      if (/^(INPUT|TEXTAREA)$/.test((e.target || {}).tagName || '')) return;
      if (e.key === ' ') { e.preventDefault(); send(playing ? 'pause' : 'play'); }
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
    });
  }
})();
