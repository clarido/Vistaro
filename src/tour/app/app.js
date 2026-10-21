/**
 * Tour shell. Generic: everything it renders comes from tours.json, and everything it drives goes
 * over the 'vistaro-tour' postMessage protocol implemented by src/engine/tour-bridge.js. There is no
 * per-product code in here, and adding a scenario means adding a catalog entry, not editing this.
 */
(function () {
  var el = function (id) { return document.getElementById(id); };
  // Solo mode drops the header and the rail from the markup, so every write to a chrome element
  // has to tolerate its absence -- otherwise the first one throws and the embed never boots.
  var setText = function (id, text) { var n = el(id); if (n) n.textContent = text; };
  var data = null, current = null, variant = null, frame = null, ready = false;
  var steps = [], chapters = [], index = -1, playing = false, starting = false;
  // Commands sent before the scenario's bridge booted: the bridge script sits at the END of the
  // page body, so a message posted during load reaches a document with no listener and is dropped.
  var pending = [];

  // ---- chrome strings ------------------------------------------------------
  // The shell is generic infrastructure, but its words are the product's voice: a tour whose
  // every scenario is French must not narrate "Step 3 of 6" in English around it. A catalog
  // overrides any of these through its top-level "strings" map, and defaults.locale (the same
  // field the timelines resolve) sets <html lang> and the document title. Unknown keys are
  // reported once, because a typo'd key would otherwise silently keep the English string.
  var EN = {
    metaTitle: '{name} — interactive tour',
    contextOne: 'Guided tour · 1 scenario',
    contextMany: 'Guided tour · {n} scenarios',
    stepNofM: 'Step {n} of {total}',
    stepAria: 'Step {n}: {title}',
    play: 'Play', pause: 'Pause', restart: 'Start over',
    prev: 'Previous step', next: 'Next step',
    fullscreen: 'Fullscreen', exitFullscreen: 'Exit fullscreen',
    stepsMenu: 'Steps', stepsCount: '{n} steps', stepsDuration: '{n} steps · {s}s',
    loadingTitle: 'Loading…',
    restTitle: 'Pick a scenario',
    restBody: 'Pick one from the list and it plays here, step by step.',
    loadErrorTitle: 'This tour could not be loaded',
    loadErrorBody: '{m} — the page must be served over http(s), not opened from disk.',
    unknownTitle: 'Unknown scenario: {s}',
    unknownBody: 'It is not in tours.json. Rebuild the tour, or fix the scenario name on this page.',
    emptyTitle: 'This tour has no scenarios',
    stepError: 'This step could not run: {m}',
    nextScenario: 'Next scenario: {label}',
    replayScenario: 'Watch again',
    smallScreenTitle: 'Better on a bigger screen',
    smallScreenBody: 'The scenarios are composed for a large display; at this size the product screen would be unreadable. Open the tour on a computer to follow it.'
  };
  var S = EN;
  var fmt = function (t, vars) {
    return String(t).replace(/\{(\w+)\}/g, function (_, k) {
      return vars && vars[k] !== undefined ? vars[k] : '';
    });
  };
  function applyStrings(strings, locale) {
    S = {};
    for (var k in EN) S[k] = EN[k];
    if (strings) for (var key in strings) {
      if (typeof strings[key] !== 'string') continue;
      if (!(key in EN)) console.warn('tours.json: unknown chrome string "' + key + '" (ignored)');
      else S[key] = strings[key];
    }
    if (locale) document.documentElement.setAttribute('lang', locale);
  }

  // ---- chrome theme --------------------------------------------------------
  // The chrome is token-driven, so a caller's brand is a set of CSS custom properties. Only the
  // tokens below are overridable -- an arbitrary property would let a theme break the layout.
  // Values go in verbatim: contrast is the caller's responsibility, not ours to second-guess.
  var THEME_VARS = {
    accent: '--accent', ink: '--ink', muted: '--muted', line: '--line',
    paper: '--paper', ground: '--ground', canvas: '--canvas', radius: '--radius', font: '--font'
  };
  function applyTheme(theme) {
    if (!theme) return;
    var root = document.documentElement.style;
    for (var k in theme) {
      if (THEME_VARS[k] && typeof theme[k] === 'string') root.setProperty(THEME_VARS[k], theme[k]);
      else console.warn('tours.json: unknown theme token "' + k + '" (ignored)');
    }
  }

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

  // English until tours.json says otherwise -- except the build bakes the catalog's locale and
  // strings into the page (window.__TOUR_CHROME__), so first paint and the load-failure path,
  // which by definition happen before the fetch can resolve, still speak the catalog's language.
  // Solo pages skip the rest copy: their scenario fills the caption the moment its entry loads,
  // and rest copy about "the list" would be wrong with no list.
  var boot = window.__TOUR_CHROME__ || null;
  if (boot) { applyStrings(boot.strings, boot.locale); applyTheme(boot.theme); }
  // Solo pages show "Loading…" until their one scenario fills the caption; the full shell shows
  // the rest copy, because with a rail the visitor can browse before choosing.
  if (solo) setText('cap-title', S.loadingTitle);
  else { setText('cap-title', S.restTitle); setText('cap-body', S.restBody); }

  fetch('tours.json')
    .then(function (r) { if (!r.ok) throw new Error('tours.json: HTTP ' + r.status); return r.json(); })
    .then(start)
    .catch(function (e) {
      // Without this the shell sits on its placeholder copy looking merely empty, and the only
      // sign of trouble is an unhandled rejection in a console nobody has open.
      setText('cap-title', S.loadErrorTitle);
      setText('cap-body', fmt(S.loadErrorBody, { m: String(e && e.message || e) }));
    });

  function start(json) {
    data = json;
    var p = data.product || {};
    applyStrings(data.strings, data.locale);
    if (p.accent) document.documentElement.style.setProperty('--accent', p.accent);
    applyTheme(data.theme);
    if (p.name) { setText('product-name', p.name); if (!solo) document.title = fmt(S.metaTitle, { name: p.name }); }
    // Only a web or relative address becomes a link: the catalog is data, and a javascript: url
    // in it must not turn the brand into a script trigger.
    // Embed pages run this file in solo mode with no brand at all, so the element may be missing.
    var brand = el('brand');
    if (brand && p.url && /^(https?:\/\/|\/|\.\.?\/)/i.test(String(p.url))) brand.setAttribute('href', p.url);
    var n = (data.scenarios || []).length;
    // Tour context, not the marketing tagline: while the visitor is being taught, the header
    // answers "what is this page", not "what is this product".
    setText('context', fmt(n === 1 ? S.contextOne : S.contextMany, { n: n }));
    setText('cap-title', S.restTitle);
    setText('cap-body', S.restBody);
    if (data.rail && data.rail.title) setText('rail-title', data.rail.title);
    if (data.rail && data.rail.subtitle) setText('rail-sub', data.rail.subtitle);
    if (!solo) renderRail();
    wireControls();
    var first = solo ? byslug(solo) : (fromHash() || data.scenarios[0]);
    if (!first) {
      setText('cap-title', solo ? fmt(S.unknownTitle, { s: solo }) : S.emptyTitle);
      setText('cap-body', solo ? S.unknownBody : '');
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
      meta.textContent = fmt(S.stepsDuration, { n: v.stepCount, s: Math.round((v.durationMs || 0) / 1000) });
    }
    b.appendChild(t);
    if (s.blurb) { var p = document.createElement('div'); p.className = 'b'; p.textContent = s.blurb; b.appendChild(p); }
    if (meta) b.appendChild(meta);
    b.onclick = function () { select(s, true); };
    return b;
  }

  /** The playing card carries a pulsing dot: state, not the English sentence the CSS used to burn in. */
  function markActive() {
    [].forEach.call(document.querySelectorAll('.card'), function (c) {
      var on = String(current && c.dataset.slug === current.slug);
      c.setAttribute('aria-current', on);
      var t = c.querySelector('.t');
      if (!t) return;
      var dot = t.querySelector('.dot');
      if (on === 'true' && document.body.classList.contains('is-playing')) {
        if (!dot) {
          dot = document.createElement('span');
          dot.className = 'dot';
          dot.setAttribute('aria-hidden', 'true');
          t.appendChild(dot);
        }
      } else if (dot) dot.remove();
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
    pending = [];   // the old scenario never sees them; the new one starts from a clean slate
    variant = variantFor(s);
    if (!solo) { location.hash = s.slug; markActive(); }
    el('cap-title').textContent = s.label;
    el('cap-body').textContent = s.blurb || '';
    el('eyebrow').textContent = '';
    setText('cap-next', '');
    el('ticks').textContent = '';
    var menu = el('steps-menu');
    if (menu) menu.textContent = '';
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
    // Never above 1x: scaling past the authored size adds no information, pads the composition
    // with canvas on both sides and can push the transport below the fold. At the cap the frame
    // is centred, so a wide well shows the scenario at its authored size on a dark stage.
    var k = Math.min(1, host.clientWidth / variant.viewport.width);
    setTooSmall(k < TOO_SMALL);
    frame.style.transform = 'scale(' + k + ')';
    host.style.height = Math.round(variant.viewport.height * k) + 'px';
    reportSize();
  }

  /**
   * Below ~a third of the authored size the mockup cannot be read honestly: a portrait phone runs
   * a desktop-authored screen at 0.28-0.33 scale (13px text lands under 4px), while every embed
   * size an author picks on purpose sits at 0.4 and up -- so the line goes at 0.35. The stage
   * explains itself instead of playing a thumbnail. A scenario authored for phones (a `devices:
   * ["mobile"]` build) resolves to a 390px variant and clears the bar on its own -- the threshold
   * is a property of the resolved variant, not of the device.
   */
  var TOO_SMALL = 0.35;
  function setTooSmall(on) {
    if (on && playing) send('pause');
    // An autoplay selected inside the zone never starts (the gate drops its play), so no state
    // arrives to clear `starting` -- clear it here or the veil stays hidden after resizing up.
    if (!on && starting) { starting = false; syncButtons(); }
    document.body.classList.toggle('too-small', on);
    var fb = el('fallback');
    if (!fb) return;
    fb.hidden = !on;
    if (on) {
      setText('fallback-title', S.smallScreenTitle);
      setText('fallback-body', S.smallScreenBody);
    }
  }
  // A rotation can cross the breakpoint, and the other form factor is a different PAGE, so the
  // scenario is reloaded rather than merely rescaled.
  addEventListener('resize', function () {
    if (current && variantFor(current) !== variant) select(current, playing);
    else fit();
  });

  function send(type, extra) {
    if (!frame || !frame.contentWindow) return;
    // The too-small stage has withdrawn the player: no command starts playback from a card that
    // says the tour needs a bigger screen.
    if (document.body.classList.contains('too-small')) return;
    // Queued, not dropped, until the frame reports ready -- the big play button is clickable while
    // the veil is up, which is exactly while the scenario is still loading.
    if (!ready) { pending.push({ type: type, extra: extra }); return; }
    var msg = { source: 'vistaro-tour', type: type };
    if (extra) for (var k in extra) msg[k] = extra[k];
    frame.contentWindow.postMessage(msg, DOWN);
  }

  /**
   * Outward relay. The bridge posts to ITS parent, which is this page, so an embedding host hears
   * nothing at all without this. Two things a host can act on: playback events (vistaro-tour.js turns
   * them into `tourstep` / `tourend` DOM events for analytics) and the page height, which is the
   * only way it can size a frame whose content it is not allowed to measure.
   */
  function toHost(type, extra) {
    if (!embedded) return;
    var msg = { source: 'vistaro-tour-embed', type: type, scenario: solo, device: soloDevice || '' };
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
    if (!d || d.source !== 'vistaro-tour-host' || !embedded || e.source !== parent) return;
    if (d.type === 'next') step(1);
    else if (d.type === 'prev') step(-1);
    else if (d.type === 'goto' && typeof d.index === 'number') send('goto', { index: d.index });
    else if (d.type === 'play' || d.type === 'pause' || d.type === 'restart') send(d.type);
  });

  // ---- messages from the scenario page ------------------------------------
  addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || d.source !== 'vistaro-tour') return;
    if (!frame || e.source !== frame.contentWindow) return;   // ignore any other frame on the page
    if (d.type === 'ready') {
      ready = true; steps = d.steps || []; buildTicks(); syncButtons(); toHost('ready', { total: d.total });
      var queued = pending; pending = [];
      for (var i = 0; i < queued.length; i++) send(queued[i].type, queued[i].extra);
    }
    else if (d.type === 'state') { index = d.index; playing = d.playing; starting = false; paint(); toHost('step', { index: d.index, chapter: currentChapter(), chapters: chapters.length, title: d.title, playing: d.playing }); }
    else if (d.type === 'end') { playing = false; starting = false; syncButtons(); showNext(); toHost('end', {}); }
    else if (d.type === 'error') {
      playing = false;
      // The failing turn's index arrives with the error (a seek-replay failure reports the
      // destination): adopt it, or the ticks stay lit on the pre-seek chapter while the caption
      // tells a different story.
      if (typeof d.index === 'number' && d.index >= 0) index = d.index;
      el('cap-body').textContent = fmt(S.stepError, { m: d.message });
      syncButtons();
      toHost('error', { message: d.message, index: d.index });
    }
  });

  /** Ticks track the guide steps; choreography (guide:false, or untitled) rides along unlabelled. */
  function buildTicks() {
    chapters = steps.filter(function (s) { return !s.hidden; });
    var box = el('ticks');
    box.textContent = '';
    var menu = el('steps-menu');
    if (menu) menu.textContent = '';
    chapters.forEach(function (c, n) {
      var aria = fmt(S.stepAria, { n: n + 1, title: c.title });
      var t = document.createElement('button');
      t.className = 'tick'; t.type = 'button';
      t.title = (n + 1) + '. ' + c.title;
      t.setAttribute('aria-label', aria);
      t.onclick = function () { send('goto', { index: c.index }); };
      box.appendChild(t);
      // The same list as a visible menu: seeking by step title must not live only in hover
      // tooltips, which ask the visitor to remember which number a title lived at.
      if (menu) {
        var mi = document.createElement('button');
        mi.type = 'button'; mi.className = 'menu-item';
        mi.textContent = (n + 1) + '. ' + c.title;
        mi.onclick = function () { closeMenu(); send('goto', { index: c.index }); };
        menu.appendChild(mi);
      }
    });
    setText('count', chapters.length ? fmt(S.stepsCount, { n: chapters.length }) : '');
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
    setText('cap-next', '');   // a seek back after the end withdraws the next-scenario offer
    if (c) {
      el('eyebrow').textContent = fmt(S.stepNofM, { n: n + 1, total: chapters.length });
      el('cap-title').textContent = c.title;
      el('cap-body').textContent = c.subtitle || c.note || '';
    }
    [].forEach.call(el('ticks').children, function (t, k) {
      t.classList.toggle('on', k === n);
      t.classList.toggle('done', k < n);
      if (k === n) t.setAttribute('aria-current', 'step'); else t.removeAttribute('aria-current');
    });
    el('count').textContent = chapters.length ? (n + 1) + ' / ' + chapters.length : '';
    [].forEach.call(document.querySelectorAll('#steps-menu .menu-item'), function (mi, k) {
      mi.classList.toggle('on', k === n);
      if (k === n) mi.setAttribute('aria-current', 'true'); else mi.removeAttribute('aria-current');
    });
    syncButtons();
    // A longer caption is a taller page, and in an embed the host is sizing the frame from what we
    // report -- so the height has to be re-sent whenever the text changes, not only on resize.
    reportSize();
  }

  function syncButtons() {
    document.body.classList.toggle('is-playing', playing);
    document.body.classList.toggle('is-ready', ready);
    markActive();
    var pb = el('btn-play');
    pb.textContent = playing ? '❚❚' : '▶';
    pb.title = playing ? S.pause : S.play;
    pb.setAttribute('aria-label', playing ? S.pause : S.play);
    el('veil').hidden = playing || starting || index >= 0;
    var none = !ready;
    el('btn-play').disabled = none;
    el('btn-restart').disabled = none;
    var bs = el('btn-steps');
    if (bs) bs.disabled = none;
    var n = currentChapter();
    el('btn-prev').disabled = none || n <= 0;
    el('btn-next').disabled = none || n >= chapters.length - 1;
  }

  /** The end of a scenario must not be a dead stop: the next one is offered where the eye is, and
   *  the last one offers the replay. */
  function showNext() {
    if (solo || !data) return;
    var slot = el('cap-next');
    if (!slot) return;
    var next = data.scenarios[data.scenarios.indexOf(current) + 1];
    slot.textContent = '';
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'link-next';
    if (next) {
      b.textContent = fmt(S.nextScenario, { label: next.label }) + ' →';
      b.onclick = function () { select(next, true); };
    } else {
      b.textContent = S.replayScenario + ' ↺';
      b.onclick = function () { send('restart'); };
    }
    slot.appendChild(b);
    reportSize();
  }

  // ---- steps menu ----------------------------------------------------------
  function openMenu() {
    var sm = el('steps-menu');
    if (!sm) return;
    sm.hidden = false;
    el('btn-steps').setAttribute('aria-expanded', 'true');
    var on = sm.querySelector('.menu-item.on') || sm.querySelector('.menu-item');
    if (on) on.focus();
  }
  function closeMenu() {
    var sm = el('steps-menu');
    if (!sm || sm.hidden) return;
    sm.hidden = true;
    el('btn-steps').setAttribute('aria-expanded', 'false');
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
    var rb = el('btn-restart');
    if (rb) { rb.title = S.restart; rb.setAttribute('aria-label', S.restart); }
    var pv = el('btn-prev');
    if (pv) { pv.title = S.prev; pv.setAttribute('aria-label', S.prev); }
    var nx = el('btn-next');
    if (nx) { nx.title = S.next; nx.setAttribute('aria-label', S.next); }
    el('btn-play').onclick = function () { send(playing ? 'pause' : 'play'); };
    el('play-big').setAttribute('aria-label', S.play);
    el('play-big').onclick = function () { send('play'); };
    el('ticks').setAttribute('aria-label', S.stepsMenu);
    var bs = el('btn-steps');
    if (bs) {
      // The visible content is the count; give AT users the affordance's name instead of "3 slash 6".
      bs.setAttribute('aria-label', S.stepsMenu);
      bs.title = S.stepsMenu;
      bs.onclick = function () {
        var sm = el('steps-menu');
        if (!sm) return;
        if (sm.hidden) openMenu(); else closeMenu();
      };
    }
    // The most-trained video gesture: clicking the picture itself toggles playback. The veil's big
    // play button sits inside the stage and is excluded here -- it would otherwise double-fire.
    var stage = el('stage');
    if (stage) stage.onclick = function (e) {
      if (!ready || (e.target && e.target.closest && e.target.closest('.play-big'))) return;
      send(playing ? 'pause' : 'play');
    };
    // Fullscreen frames the whole stage column -- caption and transport included, not a mute
    // picture: at fullscreen the canvas approaches the authored width, so the mockup's own type
    // reaches its authored size, and the step title stays readable while it does.
    var fs = el('btn-full');
    if (fs) {
      fs.title = S.fullscreen; fs.setAttribute('aria-label', S.fullscreen);
      fs.onclick = function () {
        var col = el('stage-col');
        if (document.fullscreenElement) document.exitFullscreen();
        else if (col && col.requestFullscreen) col.requestFullscreen().then(fit, function () {});
      };
    }
    document.addEventListener('fullscreenchange', function () {
      var on = !!document.fullscreenElement;
      if (fs) {
        fs.title = on ? S.exitFullscreen : S.fullscreen;
        fs.setAttribute('aria-label', on ? S.exitFullscreen : S.fullscreen);
      }
      setTimeout(fit, 60);
    });
    // Close the menu on any click outside it: the button's own click toggles, so it is excluded.
    document.addEventListener('click', function (e) {
      var sm = el('steps-menu');
      if (sm && !sm.hidden && e.target instanceof Node && bs && !bs.contains(e.target) && !sm.contains(e.target)) closeMenu();
    });
    addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        var sm = el('steps-menu');
        if (sm && !sm.hidden) { closeMenu(); if (bs) bs.focus(); }
        return;
      }
      var t = e.target || {};
      // BUTTON and SELECT too: Space is their activation key, and swallowing it made rail cards
      // and step ticks unactivatable from the keyboard (Enter worked; Space played the tour).
      if (/^(INPUT|TEXTAREA|BUTTON|SELECT)$/.test(t.tagName || '') || t.isContentEditable) return;
      if (e.key === ' ') { e.preventDefault(); send(playing ? 'pause' : 'play'); }
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
    });
  }
})();
