// The studio's front door: every editable demo in the workspace as a card -- screens, their
// scenario stories, what the catalogs name -- recents-first (the manifests' own timestamps),
// grouped by kind, filterable, keyboard-navigable. Clicking opens the editor for that project
// (?project=<id>; the server resolves ids only through its scanned registry).
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var els = {
    filter: $('filter'), groups: $('groups'), empty: $('empty'),
    'open-dir': $('open-dir'), 'open-overlay': $('open-overlay'), 'open-form': $('open-form'),
    'open-path': $('open-path'), 'open-error': $('open-error'), 'open-cancel': $('open-cancel')
  };

  var projects = [];
  var cursor = -1;   // index into the FLAT visible list (keyboard navigation)
  var visible = [];

  function fetchProjects() {
    fetch('/api/projects').then(function (r) { return r.json(); }).then(function (data) {
      projects = data.projects || [];
      render();
    }).catch(function (e) { toast('could not list projects: ' + e, 'bad'); });
  }

  function kindGroup(p) {
    if (p.tour) return 'Tour sources';
    return p.kind === 'reel' ? 'Reels' : 'Guides';
  }
  var GROUP_ORDER = ['Guides', 'Reels', 'Tour sources'];

  function relTime(iso) {
    if (!iso) return 'never touched';
    var t = Date.parse(iso);
    if (!Number.isFinite(t)) return 'touched';
    var d = new Date(t);
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    if (sameDay) {
      var mins = Math.max(1, Math.round((now - t) / 60000));
      return mins < 60 ? 'touched ' + mins + ' min ago' : 'touched ' + Math.round(mins / 60) + ' h ago';
    }
    var days = Math.round((now - t) / 86400000);
    if (days === 1) return 'touched yesterday';
    if (days < 30) return 'touched ' + days + ' days ago';
    return 'touched ' + d.toISOString().slice(0, 10);
  }

  function matches(p, q) {
    if (!q) return true;
    var hay = (p.title + ' ' + p.dir + ' ' + p.configName + ' ' + (p.kind === 'reel' ? 'reel' : 'guide') + (p.tour ? ' tour' : '')).toLowerCase();
    return q.toLowerCase().split(/\s+/).every(function (token) { return hay.indexOf(token) !== -1; });
  }

  function chip(text, cls) {
    var c = document.createElement('span');
    c.className = 'chip' + (cls ? ' ' + cls : '');
    c.textContent = text;
    return c;
  }

  function card(p, flatIndex) {
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'card-project' + (p.current ? ' is-current' : '') + (flatIndex === cursor ? ' is-cursor' : '');
    el.setAttribute('data-flat', String(flatIndex));

    var row1 = document.createElement('div');
    row1.className = 'row1';
    var title = document.createElement('span');
    title.className = 'title';
    title.textContent = p.title;
    var where = document.createElement('span');
    where.className = 'where';
    where.textContent = p.dir + (p.configName !== 'vistaro.config.json' ? ' \u00b7 ' + p.configName : '');
    row1.appendChild(title);
    row1.appendChild(where);

    var chips = document.createElement('div');
    chips.className = 'chips';
    chips.appendChild(chip(p.kind, 'is-kind'));
    if (p.tour) chips.appendChild(chip('tour', 'is-tour'));
    for (var i = 0; i < p.locales.length; i++) chips.appendChild(chip(p.locales[i]));
    for (var j = 0; j < p.devices.length; j++) chips.appendChild(chip(p.devices[j] === 'mobile' ? 'phone' : p.devices[j]));

    var foot = document.createElement('div');
    foot.className = 'foot';
    var steps = document.createElement('span');
    steps.className = 'steps';
    steps.textContent = p.steps + ' step' + (p.steps === 1 ? '' : 's');
    var touched = document.createElement('span');
    touched.className = 'touched';
    touched.textContent = relTime(p.lastTouched);
    foot.appendChild(steps);
    foot.appendChild(touched);

    el.appendChild(row1);
    el.appendChild(chips);
    el.appendChild(foot);
    el.addEventListener('click', function () { open(p); });
    el.addEventListener('mousemove', function () {
      if (cursor !== flatIndex) { cursor = flatIndex; paintCursor(); }
    });
    return el;
  }

  function open(p) {
    location.href = '/?project=' + encodeURIComponent(p.id);
  }

  function paintCursor() {
    Array.prototype.forEach.call(document.querySelectorAll('.card-project'), function (el) {
      el.classList.toggle('is-cursor', Number(el.getAttribute('data-flat')) === cursor);
    });
    var cur = document.querySelector('.card-project.is-cursor');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }

  function render() {
    var q = els.filter.value.trim();
    visible = projects.filter(function (p) { return matches(p, q); });
    cursor = Math.min(cursor, visible.length - 1);
    els.groups.innerHTML = '';
    els.empty.hidden = visible.length > 0;
    var flat = 0;
    GROUP_ORDER.forEach(function (groupName) {
      var inGroup = visible.filter(function (p) { return kindGroup(p) === groupName; });
      if (!inGroup.length) return;
      var g = document.createElement('div');
      g.className = 'picker-group';
      var h = document.createElement('h2');
      h.textContent = groupName;
      var count = document.createElement('small');
      count.textContent = inGroup.length + ' project' + (inGroup.length === 1 ? '' : 's') + ' \u00b7 newest first';
      h.appendChild(count);
      g.appendChild(h);
      var grid = document.createElement('div');
      grid.className = 'cards';
      for (var i = 0; i < inGroup.length; i++) grid.appendChild(card(inGroup[i], flat++));
      g.appendChild(grid);
      els.groups.appendChild(g);
    });
  }

  els.filter.addEventListener('input', function () { cursor = -1; render(); });
  document.addEventListener('keydown', function (e) {
    if (!els['open-overlay'].hidden) return;   // the open-folder dialog owns the keyboard
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cursor = Math.min(visible.length - 1, cursor + 1);
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      cursor = Math.max(0, cursor - 1);
      render();
    } else if (e.key === 'Enter' && cursor >= 0 && visible[cursor]) {
      e.preventDefault();
      open(visible[cursor]);
    }
  });

  function toast(text, kind) {
    var t = document.createElement('div');
    t.className = 'toast' + (kind === 'bad' ? ' is-bad' : '');
    t.textContent = text;
    document.getElementById('toasts').appendChild(t);
    setTimeout(function () { t.remove(); }, 5000);
  }

  // ---------------------------------------------------------------- open a folder
  // The picker's own scope is the workspace scan; this is the way in for a screen that lives
  // anywhere else (the UI twin of `studio <dir>`). The server validates and registers it.
  function openFolderShow() {
    els['open-overlay'].hidden = false;
    els['open-error'].hidden = true;
    els['open-path'].value = '';
    cursor = -1;   // a card cursor from before the dialog must not survive it (Enter would open that card)
    paintCursor();
    // The Browse button and its caveat only matter when the OS dialog is available at all.
    var browseable = !!window.showDirectoryPicker;
    var browseBtn = document.getElementById('open-browse');
    var note = document.getElementById('open-browse-note');
    if (browseBtn) browseBtn.hidden = !browseable;
    if (note) note.hidden = !browseable;
    els['open-path'].focus();
  }
  function openFolderClose() { els['open-overlay'].hidden = true; els.filter.focus(); }
  els['open-dir'].addEventListener('click', openFolderShow);
  els['open-cancel'].addEventListener('click', openFolderClose);
  els['open-overlay'].addEventListener('click', function (e) { if (e.target === els['open-overlay']) openFolderClose(); });
  els['open-path'].addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); openFolderClose(); } });
  els['open-form'].addEventListener('submit', function (e) {
    e.preventDefault();
    var p = els['open-path'].value.trim();
    if (!p) { els['open-path'].focus(); return; }
    els['open-error'].hidden = true;
    fetch('/api/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p }) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (res.ok) { location.href = '/?project=' + encodeURIComponent(res.data.id); return; }
        els['open-error'].textContent = res.data.error || 'could not open that directory';
        els['open-error'].hidden = false;
      })
      .catch(function (err) {
        els['open-error'].textContent = 'could not open: ' + err;
        els['open-error'].hidden = false;
      });
  });

  fetchProjects();
  els.filter.focus();
})();
