/**
 * Tour shell. Generic: everything it renders comes from tours.json, and everything it drives goes
 * over the 'anim-tour' postMessage protocol implemented by src/engine/tour-bridge.js. There is no
 * per-product code in here, and adding a scenario means adding a catalog entry, not editing this.
 */
(function () {
  var el = function (id) { return document.getElementById(id); };
  // Solo mode drops the header and the rail from the markup, so every write to a chrome element
  // has to tolerate its absence -- otherwise the first one throws and the embed never boots.
  var setText = function (id, text) { var n = el(id); if (n) n.textContent = text; };
  var data = null, current = null, variant = null, frame = null, ready = false;
  var steps = [], chapters = [], index = -1, playing = false, starting = false;

  // Solo mode: an embed page is this same shell showing one scenario with no rail. The device is
  // fixed by the page (its filename carries it) instead of being chosen here, because inside an
  // embed only the HOST knows the real viewport -- the frame is whatever size the host gave it.
  var body = document.body;
  var solo = body.getAttribute('data-scenario') || null;
  var soloDevice = body.getAttribute('data-device') || null;
  var embedded = !!solo && parent !== window;
  // Where relayed messages are sent. A tour is public content, so the default stays '*' and works
  // on any host; a deployment that knows its one embedding site can name it and stop the messages
  // being readable by an unrelated frame that happens to be listening.
  var hostOrigin = body.getAttribute('data-origin') || '*';
  // The scenario frame is served from this same origin, so it never needs a wildcard -- except on
  // file://, whose reported origin ("file://") can never match the frame's opaque origin. Sending
  // to it fails silently, which is why this keys on the protocol and not on the origin string.
  var DOWN = (location.protocol !== 'file:' && location.origin && location.origin !== 'null') ? location.origin : '*';

  fetch('tours.json')
    .then(function (r) { if (!r.ok) throw new Error('tours.json: HTTP ' + r.status); return r.json(); })
    .then(start)
    .catch(function (e) {
      // Without this the shell sits on its placeholder copy looking merely empty, and the only
      // sign of trouble is an unhandled rejection in a console nobody has open.
      setText('cap-title', 'This tour could not be loaded');
      setText('cap-body', String(e && e.message || e) + ' — the page must be served over http(s), not opened from disk.');
    });

  function start(json) {
    data = json;
    var p = data.product || {};
    if (p.accent) document.documentElement.style.setProperty('--accent', p.accent);
    if (p.name) { setText('product-name', p.name); if (!solo) document.title = p.name + ' — interactive tour'; }
    setText('tagline', p.tagline || '');
    if (data.rail && data.rail.title) setText('rail-title', data.rail.title);
    if (data.rail && data.rail.subtitle) setText('rail-sub', data.rail.subtitle);
    if (!solo) renderRail();
    wireControls();
    var first = solo ? byslug(solo) : (fromHash() || data.scenarios[0]);
    if (!first) {
      setText('cap-title', solo ? 'Unknown scenario: ' + solo : 'This tour has no scenarios');
      setText('cap-body', solo ? 'It is not in tours.json. Rebuild the tour, or fix the scenario name on this page.' : '');
      return;
    }
    if (solo) document.title = first.label;
    // An embed starts paused unless the page says otherwise: `autoplay="inview"` is the host's job,
    // and it cannot be honoured from in here for the reason the inbound listener below explains.
    select(first, solo ? body.getAttribute('data-autoplay') === 'immediate' : false);
  }

  function byslug(slug) {
    return data.scenarios.filter(function (s) { return s.slug === slug; })[0] || null;
  }

  function fromHash() {
    return byslug(location.hash.replace(/^#/, ''));
  }

  // A hash change is a same-document navigation: shared links and the back button land here, not
  // in start(), so the scenario has to be switched explicitly.
  addEventListener('hashchange', function () {
    if (solo) return;                          // an embed has one scenario and no address bar
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
    var v = variantFor(s);
    if (v && v.stepCount) {
      meta = document.createElement('span'); meta.className = 'meta';
      meta.textContent = v.stepCount + ' steps · ' + Math.round((v.durationMs || 0) / 1000) + 's';
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
  /**
   * Which form factor to show. The scenario pages are authored per device (a phone timeline drops
   * `only: "desktop"` steps), so this picks a page, not a stylesheet.
   */
  function variantFor(s) {
    var wanted = soloDevice || (matchMedia('(max-width: 768px)').matches ? 'mobile' : 'desktop');
    return s.variants[wanted] || s.variants.desktop || s.variants[Object.keys(s.variants)[0]];
  }

  function select(s, autoplay) {
    current = s; ready = false; steps = []; chapters = []; index = -1; playing = false;
    variant = variantFor(s);
    if (!solo) { location.hash = s.slug; markActive(); }
    el('cap-title').textContent = s.label;
    el('cap-body').textContent = s.blurb || '';
    el('eyebrow').textContent = '';
    el('ticks').textContent = '';
    el('count').textContent = '';
    // Held until the first state arrives: syncButtons() computes the veil from `playing`, which is
    // still false while an autoplaying scenario is loading, so without this the big play button
    // flashes over a clip that is about to start on its own.
    starting = !!autoplay;
    el('veil').hidden = starting;

    var host = el('screen');
    host.textContent = '';
    host.classList.remove('empty');
    frame = document.createElement('iframe');
    frame.title = s.label;
    frame.setAttribute('scrolling', 'no');
    frame.width = variant.viewport.width; frame.height = variant.viewport.height;
    frame.style.width = variant.viewport.width + 'px';
    frame.style.height = variant.viewport.height + 'px';
    frame.src = variant.page;
    host.appendChild(frame);
    fit();
    frame.addEventListener('load', function () { if (autoplay) send('play'); });
    syncButtons();
  }

  /** The frame keeps its authored pixel size and is scaled; the well takes the scaled height. */
  function fit() {
    if (!frame || !variant) return;
    var host = el('screen');
    var k = host.clientWidth / variant.viewport.width;
    frame.style.transform = 'scale(' + k + ')';
    host.style.height = Math.round(variant.viewport.height * k) + 'px';
    reportSize();
  }
  // A rotation can cross the breakpoint, and the other form factor is a different PAGE, so the
  // scenario is reloaded rather than merely rescaled.
  addEventListener('resize', function () {
    if (current && variantFor(current) !== variant) select(current, playing);
    else fit();
  });

  function send(type, extra) {
    if (!frame || !frame.contentWindow) return;
    var msg = { source: 'anim-tour', type: type };
    if (extra) for (var k in extra) msg[k] = extra[k];
    frame.contentWindow.postMessage(msg, DOWN);
  }

  /**
   * Outward relay. The bridge posts to ITS parent, which is this page, so an embedding host hears
   * nothing at all without this. Two things a host can act on: playback events (anim-tour.js turns
   * them into `tourstep` / `tourend` DOM events for analytics) and the page height, which is the
   * only way it can size a frame whose content it is not allowed to measure.
   */
  function toHost(type, extra) {
    if (!embedded) return;
    var msg = { source: 'anim-tour-embed', type: type, scenario: solo, device: soloDevice || '' };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) msg[k] = extra[k];
    try { parent.postMessage(msg, hostOrigin); } catch (e) { /* the host navigated away */ }
  }

  /**
   * The height the host should give this frame. Measured from the CONTENT, never from the document:
   * documentElement.scrollHeight can never report less than the frame it is already inside, so a
   * document measurement makes the height ratchet upward and never come back down -- a frame that
   * grew once for a long caption would stay tall forever, and a phone-width host would keep the
   * desktop default. `main` holds everything and its own padding, so its bottom is the whole page.
   */
  function reportSize() {
    var main = document.querySelector('main');
    if (!main) return;
    var h = Math.ceil(main.getBoundingClientRect().bottom);
    if (h > 0) toHost('size', { height: h });
  }

  /**
   * The host drives play/pause, because only it can see where the frame really is on the page: an
   * IntersectionObserver INSIDE a frame measures against that frame's own viewport, so an embed far
   * below the fold reports itself fully visible and plays to nobody. Same reason the reel snippet
   * (build.ts) puts its observer in the parent.
   */
  addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || d.source !== 'anim-tour-host' || !embedded || e.source !== parent) return;
    if (d.type === 'next') step(1);
    else if (d.type === 'prev') step(-1);
    else if (d.type === 'goto' && typeof d.index === 'number') send('goto', { index: d.index });
    else if (d.type === 'play' || d.type === 'pause' || d.type === 'restart') send(d.type);
  });

  // ---- messages from the scenario page ------------------------------------
  addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || d.source !== 'anim-tour') return;
    if (!frame || e.source !== frame.contentWindow) return;   // ignore any other frame on the page
    if (d.type === 'ready') { ready = true; steps = d.steps || []; buildTicks(); syncButtons(); toHost('ready', { total: d.total }); }
    else if (d.type === 'state') { index = d.index; playing = d.playing; starting = false; paint(); toHost('step', { index: d.index, chapter: currentChapter(), chapters: chapters.length, title: d.title, playing: d.playing }); }
    else if (d.type === 'end') { playing = false; syncButtons(); toHost('end', {}); }
    else if (d.type === 'error') {
      playing = false;
      el('cap-body').textContent = 'This step could not run: ' + d.message;
      syncButtons();
      toHost('error', { message: d.message });
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
    // A longer caption is a taller page, and in an embed the host is sizing the frame from what we
    // report -- so the height has to be re-sent whenever the text changes, not only on resize.
    reportSize();
  }

  function syncButtons() {
    document.body.classList.toggle('is-playing', playing);
    el('btn-play').textContent = playing ? '❚❚' : '▶';
    el('btn-play').title = playing ? 'Pause' : 'Play';
    el('veil').hidden = playing || starting || index >= 0;
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
    // At fullscreen the canvas approaches the authored width, so the mockup's own type reaches its
    // authored size -- the one mitigation that works on a screen already authored at 1920.
    var fs = el('btn-full');
    if (fs) fs.onclick = function () {
      var stage = el('stage');
      if (document.fullscreenElement) document.exitFullscreen();
      else if (stage.requestFullscreen) stage.requestFullscreen().then(fit, function () {});
    };
    document.addEventListener('fullscreenchange', function () { setTimeout(fit, 60); });
    addEventListener('keydown', function (e) {
      if (/^(INPUT|TEXTAREA)$/.test((e.target || {}).tagName || '')) return;
      if (e.key === ' ') { e.preventDefault(); send(playing ? 'pause' : 'play'); }
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
    });
  }
})();
