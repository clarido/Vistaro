/*
 * Vistaro Cloud dashboard: a plain-JS single page over /api (no framework,
 * no build step). Every string from the server goes through textContent via
 * h(), never innerHTML, because project titles, lead names and comments are
 * user input.
 */
(function () {
  'use strict';

  var root = document.getElementById('app');
  var state = { me: null, ws: null, slug: null, plans: null };
  try { var theme = localStorage.getItem('vistaro:theme'); if (theme) document.documentElement.dataset.theme = theme; } catch (e) { /* ok */ }

  // ---- tiny DOM builder ---------------------------------------------------
  function h(tag, attrs) {
    var el = document.createElement(tag);
    var kids = Array.prototype.slice.call(arguments, 2);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k) || attrs[k] == null || attrs[k] === false) continue;
        var v = attrs[k];
        if (k === 'class') el.className = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked') el.checked = Boolean(v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    append(el, kids);
    return el;
  }
  function append(el, kids) {
    (Array.isArray(kids) ? kids : [kids]).forEach(function (c) {
      if (c == null || c === false) return;
      if (Array.isArray(c)) append(el, c);
      else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
  }
  function mount(node) { root.textContent = ''; root.appendChild(node); }
  function logo() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 32 32');
    svg.setAttribute('aria-hidden', 'true');
    var r = document.createElementNS(ns, 'rect');
    r.setAttribute('width', '32'); r.setAttribute('height', '32'); r.setAttribute('rx', '7'); r.setAttribute('fill', '#0B101B');
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', 'M16 5l2.6 7.4L26 15l-7.4 2.6L16 25l-2.6-7.4L6 15l7.4-2.6L16 5z'); p.setAttribute('fill', '#E4632B');
    svg.appendChild(r); svg.appendChild(p);
    return h('div', { class: 'brand' }, svg, 'Vistaro Cloud');
  }

  var toastTimer = null;
  function toast(msg, bad) {
    var old = document.querySelector('.toast');
    if (old) old.remove();
    var t = h('div', { class: 'toast' + (bad ? ' bad' : ''), role: 'status' }, msg);
    document.body.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.remove(); }, 3800);
  }

  // ---- API ------------------------------------------------------------------
  function api(method, url, body) {
    var opts = { method: method, headers: { 'x-vistaro-csrf': '1' }, credentials: 'same-origin' };
    if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      var ct = r.headers.get('content-type') || '';
      var p = ct.indexOf('json') >= 0 ? r.json() : r.text();
      return p.then(function (data) {
        if (!r.ok) {
          var err = new Error((data && data.error) || ('HTTP ' + r.status));
          err.status = r.status; err.data = data;
          throw err;
        }
        return data;
      });
    });
  }
  function wsUrl(path) { return '/api/w/' + encodeURIComponent(state.slug) + (path || ''); }
  function fail(e) {
    if (e && e.status === 401) { state.me = null; return renderAuth(); }
    if (e && e.status === 402) toast(e.message + ' — see Billing to upgrade.', true);
    else toast(e && e.message ? e.message : String(e), true);
  }
  function copyField(value) {
    var input = h('input', { value: value, readonly: true, onfocus: function () { input.select(); } });
    return h('div', { class: 'copy' }, input, h('button', { class: 'btn sm', type: 'button', onclick: function () {
      (navigator.clipboard ? navigator.clipboard.writeText(value) : Promise.reject(new Error('copy blocked')))
        .then(function () { toast('Copied'); }, function () { input.select(); toast('Press ⌘C / Ctrl+C to copy'); });
    } }, 'Copy'));
  }
  function has(feature) { return state.ws && state.ws.plan.features.indexOf(feature) >= 0; }
  function lockCard(text, planName) {
    return h('div', { class: 'lock' }, h('p', null, h('strong', null, '🔒 ' + text), ' — included in ', planName || 'Pro', '.'),
      h('a', { class: 'btn primary sm', href: '#billing' }, 'See plans'));
  }
  function fmtPct(x) { return Math.round((x || 0) * 100) + '%'; }
  function fmtMs(ms) { if (ms == null) return '—'; var s = Math.round(ms / 1000); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's'; }
  function fmtDate(s) { try { return new Date(s).toLocaleString(); } catch (e) { return s; } }

  // ---- auth ----------------------------------------------------------------
  function renderAuth(mode) {
    var inviteEmail = null;
    var m = /invite=([^&]+)/.exec(location.hash);
    if (m) { inviteEmail = decodeURIComponent(m[1]); mode = 'signup'; }
    mode = mode || (/signup/.test(location.hash) ? 'signup' : 'login');
    var err = h('p', { class: 'err', role: 'alert' });
    var email = h('input', { type: 'email', required: true, autocomplete: 'email', value: inviteEmail || '' });
    var pass = h('input', { type: 'password', required: true, minlength: '8', autocomplete: mode === 'signup' ? 'new-password' : 'current-password' });
    var name = h('input', { autocomplete: 'name' });
    var wsName = h('input', { placeholder: 'Acme' });
    var form = h('form', { class: 'stack', onsubmit: function (e) {
      e.preventDefault();
      err.textContent = '';
      var body = { email: email.value, password: pass.value };
      if (mode === 'signup') { body.name = name.value; body.workspaceName = wsName.value || undefined; }
      api('POST', '/api/' + mode, body).then(function () { location.hash = '#projects'; boot(); }, function (e2) { err.textContent = e2.message; });
    } },
      mode === 'signup' ? h('label', null, 'Your name', name) : null,
      h('label', null, 'Email', email),
      h('label', null, 'Password', pass),
      mode === 'signup' && !inviteEmail ? h('label', null, 'Company or team (workspace name)', wsName) : null,
      h('button', { class: 'btn primary', type: 'submit' }, mode === 'signup' ? 'Create free account' : 'Sign in'),
      err,
      h('p', { class: 'muted small' }, mode === 'signup'
        ? ['Free forever for up to 3 published demos. ', h('a', { href: '#login', onclick: function (e) { e.preventDefault(); renderAuth('login'); } }, 'Have an account? Sign in')]
        : ['New here? ', h('a', { href: '#signup', onclick: function (e) { e.preventDefault(); renderAuth('signup'); } }, 'Create a free account')]));
    mount(h('div', { class: 'auth' }, h('div', { class: 'auth-card' }, logo(),
      h('p', { class: 'muted', style: 'margin-top:-6px' }, inviteEmail ? 'You were invited to a workspace. Create your account to join.' : 'Publish, measure and share the demos your agent builds.'),
      form)));
    (mode === 'signup' && !inviteEmail ? name : email).focus();
  }

  // ---- shell ---------------------------------------------------------------
  var NAV = [
    ['projects', 'Demos'], ['help', 'Help center'], ['team', 'Team'], ['ci', 'Publish from CI'],
    ['settings', 'Settings'], ['billing', 'Plan & billing'], ['audit', 'Audit log'],
  ];

  function shell(active, content) {
    var side = h('aside', { class: 'side', id: 'side' });
    var select = h('select', { 'aria-label': 'Workspace', onchange: function () { switchWs(select.value); } },
      state.me.workspaces.map(function (w) { return h('option', { value: w.slug, selected: w.slug === state.slug }, w.name); }));
    append(side, [
      logo(),
      state.me.workspaces.length > 1 ? select : h('div', { class: 'muted small' }, state.ws.name),
      h('div', null, h('span', { class: 'tag accent' }, state.ws.plan.name + ' plan')),
      h('nav', null, NAV.map(function (n) {
        return h('a', { href: '#' + n[0], 'aria-current': n[0] === active ? 'page' : null }, n[1]);
      })),
      h('div', { class: 'foot' },
        h('span', null, state.me.user.email),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', type: 'button', onclick: toggleTheme }, 'Theme'),
          h('button', { class: 'btn sm', type: 'button', onclick: function () { api('POST', '/api/logout', {}).then(function () { state.me = null; renderAuth('login'); }); } }, 'Sign out'))),
    ]);
    var menu = h('button', { class: 'btn sm menu-btn', type: 'button', onclick: function () { side.classList.toggle('open'); } }, 'Menu');
    mount(h('div', { class: 'shell' }, side, h('div', null, menu, h('main', { class: 'main' }, content))));
  }
  function toggleTheme() {
    var cur = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = cur;
    try { localStorage.setItem('vistaro:theme', cur); } catch (e) { /* ok */ }
  }
  function switchWs(slug) {
    state.slug = slug;
    try { localStorage.setItem('vistaro:ws', slug); } catch (e) { /* ok */ }
    loadWs().then(route);
  }
  function head(title, sub, actions) {
    return h('div', { class: 'head' }, h('div', null, h('h1', null, title), sub ? h('p', { class: 'muted', style: 'margin:0' }, sub) : null), actions || null);
  }

  // ---- views ---------------------------------------------------------------
  function viewProjects() {
    var box = h('div', { class: 'cards' }, h('p', { class: 'muted' }, 'Loading…'));
    shell('projects', [head('Demos', 'Everything your CLI built and published. Rendering stays on your machine or CI; the Cloud hosts, measures and shares it.',
      h('a', { class: 'btn primary', href: '#ci' }, 'Publish a demo')), box]);
    api('GET', wsUrl('/projects')).then(function (d) {
      box.textContent = '';
      if (!d.projects.length) {
        box.appendChild(h('div', { class: 'card', style: 'grid-column:1/-1' },
          h('h2', null, 'Publish your first demo'),
          h('p', { class: 'muted' }, 'Build it with the free CLI as usual, then upload the output. A guide, a tour site, a reel or a video all work.'),
          h('pre', { class: 'code' }, 'npx tsx cli.ts export demo -o demo/demo.mp4 --guide\nVISTARO_TOKEN=vt_… node saas/bin/vistaro-cloud.mjs publish demo --project getting-started'),
          h('p', { class: 'small' }, h('a', { href: '#ci' }, 'Create a token and see the CI setup →'))));
        return;
      }
      d.projects.forEach(function (p) {
        var stale = p.freshness && p.freshness.stale && p.freshness.stale.length;
        box.appendChild(h('a', { class: 'card pcard', href: '#project/' + encodeURIComponent(p.slug) },
          h('div', { class: 'row' }, h('h3', { class: 'grow' }, p.title), h('span', { class: 'tag' }, p.kind || '—')),
          h('div', { class: 'row small muted' },
            p.live ? h('span', { class: 'tag ok' }, 'live #' + p.live) : h('span', { class: 'tag warn' }, 'not live'),
            p.drafts ? h('span', { class: 'tag warn' }, p.drafts + ' awaiting review') : null,
            stale ? h('span', { class: 'tag bad' }, stale + ' stale') : null,
            p.settings.password ? h('span', { class: 'tag' }, 'password') : null,
            p.settings.gate && p.settings.gate.enabled ? h('span', { class: 'tag' }, 'lead gate') : null),
          h('div', { class: 'row small' },
            h('span', null, h('strong', null, String(p.stats.views)), ' views · 30d'),
            h('span', null, h('strong', null, fmtPct(p.stats.completionRate)), ' completed'),
            h('span', null, h('strong', null, String(p.stats.leads)), ' leads'))));
      });
    }, fail);
  }

  function viewProject(slug, tab) {
    tab = tab || 'overview';
    var body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
    var tabs = [['overview', 'Overview'], ['analytics', 'Analytics'], ['leads', 'Leads'], ['releases', 'Releases & review'], ['translations', 'Translations'], ['settings', 'Settings']];
    api('GET', wsUrl('/projects/' + encodeURIComponent(slug))).then(function (d) {
      var p = d.project;
      shell('projects', [
        head(p.title, [p.kind || '', p.live ? ' · live release #' + p.live : ' · not live'].join(''),
          p.live ? h('a', { class: 'btn', href: p.urls.live, target: '_blank', rel: 'noopener' }, 'Open live ↗') : null),
        h('div', { class: 'tabs', role: 'tablist' }, tabs.map(function (t) {
          return h('button', { role: 'tab', 'aria-selected': String(t[0] === tab), onclick: function () { location.hash = '#project/' + encodeURIComponent(slug) + '/' + t[0]; } }, t[1]);
        })),
        body]);
      body.textContent = '';
      var fn = { overview: tabOverview, analytics: tabAnalytics, leads: tabLeads, releases: tabReleases, translations: tabTranslations, settings: tabSettings }[tab] || tabOverview;
      fn(body, p, d.releases);
    }, function (e) { if (e.status === 404) { location.hash = '#projects'; } else fail(e); });
  }

  function tabOverview(body, p, releases) {
    var stale = p.freshness && p.freshness.stale && p.freshness.stale.length;
    append(body, [
      h('div', { class: 'kpis' },
        h('div', { class: 'kpi' }, h('b', null, String(p.stats.views)), h('span', null, 'views, last 30 days')),
        h('div', { class: 'kpi' }, h('b', null, fmtPct(p.stats.completionRate)), h('span', null, 'watched to the end')),
        h('div', { class: 'kpi' }, h('b', null, String(p.stats.leads)), h('span', null, 'leads captured')),
        h('div', { class: 'kpi' }, h('b', null, String(releases.length)), h('span', null, 'releases kept'))),
      stale ? h('div', { class: 'card' }, h('h2', null, '⚠ ' + stale + ' guide(s) no longer match the product'),
        h('p', { class: 'muted small' }, 'Your last build-all --diff marked these stale: ' + p.freshness.stale.join(', ') + '. Rebuild and publish again; the CLI only re-renders what changed.')) : null,
      h('div', { class: 'card stack' },
        h('h2', null, 'Share'),
        h('label', null, 'Public link', copyField(p.urls.live)),
        p.urls.customDomain ? h('label', null, 'On your domain', copyField(p.urls.customDomain)) : null,
        h('label', null, 'Embed on your site or docs', copyField(p.urls.embed))),
    ]);
  }

  function barChart(daily) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'chart');
    svg.setAttribute('viewBox', '0 0 600 160');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    var max = Math.max(1, Math.max.apply(null, daily.map(function (d) { return d.views; })));
    var w = 600 / daily.length;
    daily.forEach(function (d, i) {
      var hgt = Math.round((d.views / max) * 130);
      var r = document.createElementNS(ns, 'rect');
      r.setAttribute('class', 'bar'); r.setAttribute('x', String(i * w + 1)); r.setAttribute('width', String(Math.max(1, w - 2)));
      r.setAttribute('y', String(140 - hgt)); r.setAttribute('height', String(hgt));
      var t = document.createElementNS(ns, 'title'); t.textContent = d.day + ': ' + d.views + ' views, ' + d.completions + ' completions';
      r.appendChild(t);
      svg.appendChild(r);
    });
    svg.setAttribute('aria-label', 'Daily views over ' + daily.length + ' days, peak ' + max);
    return svg;
  }

  function tabAnalytics(body, p) {
    var days = Number(sessionStorage.getItem('vistaro:days') || 30);
    var picker = h('select', { 'aria-label': 'Window', style: 'width:auto', onchange: function () { sessionStorage.setItem('vistaro:days', picker.value); body.textContent = ''; tabAnalytics(body, p); } },
      [7, 30, 90, 365].map(function (n) { return h('option', { value: String(n), selected: n === days }, 'Last ' + n + ' days'); }));
    append(body, h('div', { class: 'row' }, picker));
    api('GET', wsUrl('/projects/' + encodeURIComponent(p.slug) + '/analytics?days=' + days)).then(function (a) {
      var t = a.totals;
      append(body, [
        a.retentionDays && days > a.retentionDays ? h('p', { class: 'muted small' }, 'Your plan keeps ' + a.retentionDays + ' days of analytics; showing ' + a.windowDays + '.') : null,
        h('div', { class: 'kpis' },
          h('div', { class: 'kpi' }, h('b', null, String(t.views)), h('span', null, 'views')),
          h('div', { class: 'kpi' }, h('b', null, String(t.sessions)), h('span', null, 'visits')),
          h('div', { class: 'kpi' }, h('b', null, fmtPct(t.completionRate)), h('span', null, 'completion')),
          h('div', { class: 'kpi' }, h('b', null, fmtMs(t.medianDwellMs)), h('span', null, 'median time')),
          h('div', { class: 'kpi' }, h('b', null, fmtPct(t.ctaRate)), h('span', null, 'CTA click-through')),
          h('div', { class: 'kpi' }, h('b', null, String(t.leads)), h('span', null, 'leads'))),
        h('div', { class: 'card' }, h('h2', null, 'Views per day'), barChart(a.daily)),
        h('div', { class: 'card' }, h('h2', null, 'Where viewers drop off'),
          a.funnelsLocked ? lockCard('Step-by-step drop-off funnels', 'Pro')
            : (a.funnel && a.funnel.length ? a.funnel.map(function (f) {
              return h('div', { class: 'funnel-row' },
                h('span', null, (f.scenario ? f.scenario + ' · ' : '') + (f.n + 1) + '. ' + (f.label || 'step')),
                h('div', { class: 'funnel-bar' }, h('i', { style: 'width:' + Math.round(f.reach * 100) + '%' })),
                h('span', { class: 'small muted' }, fmtPct(f.reach)));
            }) : h('p', { class: 'muted small' }, 'No step data yet. Guides and tours report each step a viewer reaches.'))),
        h('div', { class: 'card' }, h('h2', null, 'Top referrers'),
          a.referrers.length ? h('table', null, h('tbody', null, a.referrers.map(function (r) { return h('tr', null, h('td', null, r.host), h('td', null, String(r.count))); })))
            : h('p', { class: 'muted small' }, 'No referrers yet. Direct visits and embeds on your own site show up here.')),
        h('p', { class: 'muted small' }, 'Cookieless: visits are counted with a per-tab random id; no personal data is collected unless a viewer fills in a lead form.'),
      ]);
    }, fail);
  }

  function tabLeads(body, p) {
    if (!has('lead-capture')) append(body, lockCard('Lead capture forms on demos', 'Pro'));
    api('GET', wsUrl('/projects/' + encodeURIComponent(p.slug) + '/leads')).then(function (d) {
      append(body, [
        h('div', { class: 'row' },
          h('p', { class: 'muted grow', style: 'margin:0' }, p.settings.gate && p.settings.gate.enabled ? 'The lead gate is on: viewers leave their email before the demo plays.' : 'The lead gate is off. Turn it on in Settings.'),
          has('csv-export') ? h('a', { class: 'btn sm', href: wsUrl('/projects/' + encodeURIComponent(p.slug) + '/leads?format=csv') }, 'Export CSV') : null),
        d.leads.length ? h('div', { class: 'card table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, ['Email', 'Name', 'Company', 'Referrer', 'When'].map(function (c) { return h('th', null, c); }))),
          h('tbody', null, d.leads.map(function (l) { return h('tr', null, h('td', null, l.email), h('td', null, l.name || ''), h('td', null, l.company || ''), h('td', null, l.referrer || ''), h('td', null, fmtDate(l.at))); }))))
          : h('div', { class: 'card empty' }, 'No leads yet.'),
        has('webhooks') ? null : h('p', { class: 'muted small' }, 'Send every lead to Slack, HubSpot or Zapier with webhooks on the Team plan.'),
      ]);
    }, fail);
  }

  function tabReleases(body, p, releases) {
    if (!releases.length) { append(body, h('div', { class: 'card empty' }, 'No releases yet.')); return; }
    var panel = h('div', { class: 'card stack', hidden: true });
    append(body, [
      h('div', { class: 'card table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['#', 'Status', 'Source', 'Published', ''].map(function (c) { return h('th', null, c); }))),
        h('tbody', null, releases.map(function (r) {
          var src = r.git ? [r.git.branch, r.git.sha ? r.git.sha.slice(0, 7) : null, r.git.pr ? 'PR ' + r.git.pr : null].filter(Boolean).join(' · ') : (r.notes || '');
          var status = r.status === 'live' ? h('span', { class: 'tag ok' }, 'live') : r.status === 'draft' ? h('span', { class: 'tag warn' }, 'awaiting review') : h('span', { class: 'tag' }, 'archived');
          var actions = h('div', { class: 'row' },
            h('a', { class: 'btn sm', href: r.preview, target: '_blank', rel: 'noopener' }, 'Preview'),
            has('review') ? h('button', { class: 'btn sm', type: 'button', onclick: function () { showComments(panel, p, r); } }, 'Comments' + (r.comments ? ' (' + r.comments + ')' : '')) : null,
            r.status === 'draft' ? h('button', { class: 'btn sm primary', type: 'button', onclick: function () { promote(p, r, 'Approved and live'); } }, 'Approve & go live') : null,
            r.status === 'archived' ? h('button', { class: 'btn sm', type: 'button', disabled: !has('rollback'), title: has('rollback') ? null : 'Rollback is part of Pro', onclick: function () { promote(p, r, 'Rolled back'); } }, 'Roll back to this') : null);
          return h('tr', null, h('td', null, String(r.number)), h('td', null, status), h('td', { class: 'small' }, src || '—', h('div', { class: 'muted' }, r.steps + ' steps · ' + r.files + ' files')), h('td', { class: 'small' }, fmtDate(r.createdAt)), h('td', null, actions));
        })))),
      has('review') ? null : lockCard('Draft releases, review links, comments and approvals', 'Team'),
      panel,
    ]);
  }
  function promote(p, r, msg) {
    api('POST', wsUrl('/projects/' + encodeURIComponent(p.slug) + '/releases/' + r.number + '/promote'), {}).then(function () { toast(msg + ': #' + r.number); route(); }, fail);
  }
  function showComments(panel, p, r) {
    panel.hidden = false;
    panel.textContent = '';
    var url = wsUrl('/projects/' + encodeURIComponent(p.slug) + '/releases/' + r.number + '/comments');
    var list = h('div');
    var text = h('textarea', { placeholder: 'What should change before this goes live?' });
    var step = h('input', { placeholder: 'Step (optional), e.g. 3 or "Export"' });
    append(panel, [h('h2', null, 'Review of release #' + r.number), list,
      h('form', { class: 'stack', onsubmit: function (e) {
        e.preventDefault();
        api('POST', url, { body: text.value, step: step.value || undefined }).then(function () { text.value = ''; load(); }, fail);
      } }, text, step, h('div', null, h('button', { class: 'btn primary sm', type: 'submit' }, 'Comment')))]);
    function load() {
      api('GET', url).then(function (d) {
        list.textContent = '';
        if (!d.comments.length) list.appendChild(h('p', { class: 'muted small' }, 'No comments yet. Share the preview link with reviewers.'));
        d.comments.forEach(function (c) {
          list.appendChild(h('div', { class: 'comment' + (c.resolved ? ' resolved' : '') },
            h('div', { class: 'row small' }, h('strong', null, c.author), c.step ? h('span', { class: 'tag' }, 'step ' + c.step) : null, h('span', { class: 'muted grow' }, fmtDate(c.at)),
              h('button', { class: 'btn sm', type: 'button', onclick: function () { api('PATCH', url + '/' + c.id, { resolved: !c.resolved }).then(load, fail); } }, c.resolved ? 'Reopen' : 'Resolve')),
            h('p', { style: 'margin:6px 0 0;white-space:pre-wrap' }, c.body)));
        });
      }, fail);
    }
    load();
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function tabTranslations(body, p) {
    if (!has('translations')) {
      append(body, [lockCard('Translation workspace and translator seats', 'Team'),
        h('p', { class: 'muted small' }, 'Translators edit every strings.<locale>.json of a demo here; CI pulls the result back into the repo and the free CLI rebuilds each locale.')]);
      return;
    }
    api('GET', wsUrl('/projects/' + encodeURIComponent(p.slug) + '/strings')).then(function (d) {
      var locs = Object.keys(d.locales);
      if (!d.base || !d.keys.length) {
        append(body, h('div', { class: 'card' }, h('h2', null, 'No strings published yet'),
          h('p', { class: 'muted small' }, 'Publish a bundle that includes strings.<locale>.json files (run localize, then include the demo directory) and they appear here.')));
        return;
      }
      var targets = locs.filter(function (l) { return l !== d.base; });
      var sel = h('select', { 'aria-label': 'Target language' }, targets.map(function (l) { return h('option', { value: l }, l + ' — ' + d.locales[l].missing + ' missing'); }));
      var newLoc = h('input', { placeholder: 'add a locale, e.g. de', style: 'max-width:180px' });
      var grid = h('div', { class: 'card table-wrap' });
      function draw(loc) {
        grid.textContent = '';
        var vals = (d.locales[loc] && d.locales[loc].values) || {};
        var inputs = {};
        var rows = d.keys.map(function (k) {
          var inp = h('textarea', { class: 'tr-input', rows: '2', value: vals[k] || '', 'aria-label': k + ' in ' + loc });
          inputs[k] = inp;
          return h('tr', null, h('td', { class: 'mono small', style: 'max-width:200px;word-break:break-all' }, k), h('td', null, d.locales[d.base].values[k]), h('td', null, inp));
        });
        append(grid, [h('table', null, h('thead', null, h('tr', null, h('th', null, 'Key'), h('th', null, d.base), h('th', null, loc))), h('tbody', null, rows)),
          h('div', { class: 'row', style: 'margin-top:12px' },
            h('button', { class: 'btn primary', type: 'button', onclick: function () {
              var values = {};
              Object.keys(inputs).forEach(function (k) { if ((vals[k] || '') !== inputs[k].value) values[k] = inputs[k].value; });
              api('PUT', wsUrl('/projects/' + encodeURIComponent(p.slug) + '/strings/' + encodeURIComponent(loc)), { values: values })
                .then(function (r) { d.locales[loc] = d.locales[loc] || {}; d.locales[loc].values = r.values; vals = r.values; toast('Saved ' + r.changed + ' string(s) for ' + loc); }, fail);
            } }, 'Save ' + loc),
            h('span', { class: 'muted small' }, 'CI pulls it with: node saas/bin/vistaro-cloud.mjs pull-strings <dir> --project ' + p.slug + ' --locale ' + loc))]);
      }
      sel.addEventListener('change', function () { draw(sel.value); });
      append(body, [h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Source: ' + d.base + ' · ' + d.keys.length + ' strings'), sel,
        newLoc, h('button', { class: 'btn sm', type: 'button', onclick: function () {
          var l = newLoc.value.trim();
          if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(l)) { toast('Use a locale code like de or pt-BR', true); return; }
          if (!d.locales[l]) { d.locales[l] = { values: {}, missing: d.keys.length }; sel.appendChild(h('option', { value: l }, l + ' — new')); }
          sel.value = l; draw(l); newLoc.value = '';
        } }, 'Add')), grid]);
      if (targets.length) draw(targets[0]);
      else grid.appendChild(h('p', { class: 'muted' }, 'Only the source language is published. Add a locale to start translating.'));
    }, fail);
  }

  function tabSettings(body, p) {
    var title = h('input', { value: p.title });
    var gate = p.settings.gate || { enabled: false, fields: ['email'] };
    var gateOn = h('input', { type: 'checkbox', checked: gate.enabled, disabled: !has('lead-capture'), style: 'width:auto' });
    var gateHead = h('input', { value: gate.headline || '' });
    var fName = h('input', { type: 'checkbox', checked: gate.fields.indexOf('name') >= 0, style: 'width:auto' });
    var fCo = h('input', { type: 'checkbox', checked: gate.fields.indexOf('company') >= 0, style: 'width:auto' });
    var ctaLabel = h('input', { value: (p.settings.cta && p.settings.cta.label) || '', placeholder: 'Start free trial', disabled: !has('cta') });
    var ctaUrl = h('input', { value: (p.settings.cta && p.settings.cta.url) || '', placeholder: 'https://yourapp.com/signup', disabled: !has('cta') });
    var pw = h('input', { type: 'password', placeholder: p.settings.password ? '•••••• (set; type to change)' : 'No password', disabled: !has('password'), autocomplete: 'new-password' });
    function save(patch, msg) {
      return api('PATCH', wsUrl('/projects/' + encodeURIComponent(p.slug)), patch).then(function () { toast(msg || 'Saved'); route(); }, fail);
    }
    append(body, [
      h('div', { class: 'card stack' }, h('h2', null, 'Basics'), h('label', null, 'Title', title),
        h('div', null, h('button', { class: 'btn primary', type: 'button', onclick: function () { save({ title: title.value }); } }, 'Save'))),
      h('div', { class: 'card stack' }, h('h2', null, 'Lead capture'),
        has('lead-capture') ? null : lockCard('Lead capture forms on demos', 'Pro'),
        h('label', { class: 'row', style: 'font-weight:600;color:var(--ink)' }, gateOn, 'Ask for an email before the demo plays'),
        h('label', null, 'Headline', gateHead),
        h('div', { class: 'row small' }, h('label', { class: 'row' }, fName, 'Name'), h('label', { class: 'row' }, fCo, 'Company')),
        h('div', null, h('button', { class: 'btn primary', type: 'button', disabled: !has('lead-capture'), onclick: function () {
          var fields = ['email']; if (fName.checked) fields.push('name'); if (fCo.checked) fields.push('company');
          save({ gate: { enabled: gateOn.checked, headline: gateHead.value, fields: fields } });
        } }, 'Save lead capture'))),
      h('div', { class: 'card stack' }, h('h2', null, 'Call to action'),
        has('cta') ? null : lockCard('Call-to-action button on every demo', 'Pro'),
        h('div', { class: 'row' }, h('label', { class: 'grow' }, 'Button label', ctaLabel), h('label', { class: 'grow' }, 'Link', ctaUrl)),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', disabled: !has('cta'), onclick: function () { save({ cta: ctaUrl.value ? { label: ctaLabel.value, url: ctaUrl.value } : null }); } }, 'Save CTA'),
          p.settings.cta ? h('button', { class: 'btn', type: 'button', onclick: function () { save({ cta: null }, 'CTA removed'); } }, 'Remove') : null)),
      h('div', { class: 'card stack' }, h('h2', null, 'Password protection'),
        has('password') ? h('p', { class: 'muted small', style: 'margin:0' }, 'For unreleased features, partner previews and sales demos. Embeds and the help center hide protected demos.') : lockCard('Password-protected demos', 'Pro'),
        h('label', null, 'Password', pw),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', disabled: !has('password'), onclick: function () { if (pw.value) save({ password: pw.value }, 'Password set'); } }, 'Set password'),
          p.settings.password ? h('button', { class: 'btn', type: 'button', onclick: function () { save({ password: null }, 'Password removed'); } }, 'Remove password') : null)),
      h('div', { class: 'card stack' }, h('h2', null, 'Danger zone'),
        h('div', null, h('button', { class: 'btn danger', type: 'button', onclick: function () {
          if (!confirm('Delete "' + p.title + '", every release, its analytics and its leads? This cannot be undone.')) return;
          api('DELETE', wsUrl('/projects/' + encodeURIComponent(p.slug))).then(function () { toast('Deleted'); location.hash = '#projects'; }, fail);
        } }, 'Delete this demo'))),
    ]);
  }

  function viewHelp() {
    var hc = state.ws.urls.helpCenter;
    shell('help', [head('Help center', 'One branded, searchable site for every guide, tour and video you publish, in every language.'),
      hc ? h('div', { class: 'card stack' }, h('label', null, 'Your help center', copyField(hc)),
        state.ws.customDomain ? h('label', null, 'On your domain', copyField('https://' + state.ws.customDomain + '/')) : h('p', { class: 'muted small' }, 'Point help.yourapp.com at it in Settings → Custom domain.'),
        h('div', null, h('a', { class: 'btn primary', href: hc, target: '_blank', rel: 'noopener' }, 'Open help center ↗')))
        : lockCard('Branded, searchable help center across every guide and locale', 'Team')]);
  }

  function viewTeam() {
    var box = h('div', { class: 'stack' });
    shell('team', [head('Team', 'Invite the people who publish, review and translate.'), box]);
    api('GET', wsUrl('/members')).then(function (d) {
      var email = h('input', { type: 'email', placeholder: 'teammate@company.com' });
      var role = h('select', { 'aria-label': 'Role' },
        h('option', { value: 'editor' }, 'Editor — publish & configure'),
        h('option', { value: 'admin' }, 'Admin — plus team & settings'),
        h('option', { value: 'translator', disabled: !has('translations') }, 'Translator — translations only' + (has('translations') ? '' : ' (Team)')));
      append(box, [
        h('div', { class: 'card stack' }, h('h2', null, 'Invite'),
          h('p', { class: 'muted small', style: 'margin:0' }, d.seats.used + ' of ' + (d.seats.limit == null ? 'unlimited' : d.seats.limit) + ' seats used.'),
          h('form', { class: 'row', onsubmit: function (e) {
            e.preventDefault();
            api('POST', wsUrl('/members'), { email: email.value, role: role.value }).then(function (r) {
              toast(r.added ? 'Added to the workspace' : 'Invited. Share the signup link.');
              if (r.link) prompt('Send this signup link to your teammate:', r.link);
              viewTeam();
            }, fail);
          } }, h('div', { class: 'grow' }, email), role, h('button', { class: 'btn primary', type: 'submit' }, 'Invite'))),
        h('div', { class: 'card table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Member'), h('th', null, 'Role'), h('th', null, ''))),
          h('tbody', null,
            d.members.map(function (m) {
              return h('tr', null, h('td', null, m.name || '', h('div', { class: 'muted small' }, m.email)), h('td', null, m.role),
                h('td', null, m.userId !== state.me.user.id ? h('button', { class: 'btn sm danger', type: 'button', onclick: function () { api('DELETE', wsUrl('/members/' + m.userId)).then(viewTeam, fail); } }, 'Remove') : h('span', { class: 'muted small' }, 'you')));
            }),
            d.invites.map(function (i) {
              return h('tr', null, h('td', null, i.email, h('div', { class: 'muted small' }, 'invited ' + fmtDate(i.createdAt))), h('td', null, i.role),
                h('td', null, h('button', { class: 'btn sm', type: 'button', onclick: function () { api('DELETE', wsUrl('/members/' + encodeURIComponent(i.email))).then(viewTeam, fail); } }, 'Cancel')));
            })))),
      ]);
    }, fail);
  }

  function viewCi() {
    var box = h('div', { class: 'stack' });
    shell('ci', [head('Publish from CI', 'Render with the free CLI in your pipeline, then publish the output. The Cloud never re-renders, so there are no build minutes to buy.'), box]);
    var origin = location.origin;
    append(box, h('div', { class: 'card stack' }, h('h2', null, 'GitHub Actions'),
      h('pre', { class: 'code' }, [
        '# .github/workflows/demos.yml',
        'on: { push: { branches: [main] }, pull_request: {} }',
        'jobs:',
        '  demos:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - uses: actions/setup-node@v4',
        '        with: { node-version: 20 }',
        '      - run: npm ci && npx playwright install --with-deps chromium',
        '      - run: npx tsx cli.ts export demo -o demo/demo.mp4 --guide',
        '      - run: node saas/bin/vistaro-cloud.mjs publish demo --project getting-started ${{ github.event_name == \'pull_request\' && \'--draft\' || \'\' }}',
        '        env:',
        '          VISTARO_TOKEN: ${{ secrets.VISTARO_TOKEN }}',
        '          VISTARO_URL: ' + origin,
      ].join('\n')),
      h('p', { class: 'muted small', style: 'margin:0' }, 'Pull requests publish a draft with a review link (Team); main goes live. Commit SHA, branch and PR number are attached to each release automatically.')));
    if (state.ws.role !== 'owner' && state.ws.role !== 'admin') { append(box, h('p', { class: 'muted' }, 'Ask an admin to create a token.')); return; }
    var list = h('div', { class: 'card table-wrap' });
    var name = h('input', { placeholder: 'GitHub Actions' });
    var shown = h('div');
    append(box, [h('div', { class: 'card stack' }, h('h2', null, 'Workspace tokens'),
      h('form', { class: 'row', onsubmit: function (e) {
        e.preventDefault();
        api('POST', wsUrl('/tokens'), { name: name.value || 'CI' }).then(function (r) {
          shown.textContent = '';
          append(shown, [h('p', { class: 'small' }, h('strong', null, 'Copy it now: it will not be shown again.')), copyField(r.token)]);
          name.value = ''; loadTokens();
        }, fail);
      } }, h('div', { class: 'grow' }, name), h('button', { class: 'btn primary', type: 'submit' }, 'Create token')), shown), list]);
    function loadTokens() {
      api('GET', wsUrl('/tokens')).then(function (d) {
        list.textContent = '';
        if (!d.tokens.length) { list.appendChild(h('p', { class: 'muted', style: 'margin:0' }, 'No tokens yet.')); return; }
        list.appendChild(h('table', null, h('thead', null, h('tr', null, ['Name', 'Prefix', 'Created', 'Last used', ''].map(function (c) { return h('th', null, c); }))),
          h('tbody', null, d.tokens.map(function (t) {
            return h('tr', null, h('td', null, t.name), h('td', { class: 'mono' }, t.prefix + '…'), h('td', { class: 'small' }, fmtDate(t.createdAt)), h('td', { class: 'small' }, t.lastUsedAt ? fmtDate(t.lastUsedAt) : 'never'),
              h('td', null, h('button', { class: 'btn sm danger', type: 'button', onclick: function () { if (confirm('Revoke ' + t.name + '?')) api('DELETE', wsUrl('/tokens/' + t.id)).then(loadTokens, fail); } }, 'Revoke')));
          }))));
      }, fail);
    }
    loadTokens();
  }

  function viewSettings() {
    var ws = state.ws;
    var admin = ws.role === 'owner' || ws.role === 'admin';
    var name = h('input', { value: ws.name, disabled: !admin });
    var accent = h('input', { type: 'color', value: (ws.brand && ws.brand.accent) || '#E4632B', style: 'width:64px;padding:2px', disabled: !admin });
    var logoText = h('input', { value: (ws.brand && ws.brand.logoText) || '', disabled: !admin });
    var domain = h('input', { value: ws.customDomain || '', placeholder: 'help.yourapp.com', disabled: !admin || !has('custom-domain') });
    var hook = h('input', { value: ws.webhookUrl || '', placeholder: 'https://hooks.slack.com/services/…', disabled: !admin || !has('webhooks') });
    var review = h('input', { type: 'checkbox', checked: ws.requireReview, disabled: !admin || !has('review'), style: 'width:auto' });
    function save(patch) {
      return api('PATCH', wsUrl(''), patch).then(function (w) { state.ws = w; toast('Saved'); viewSettings(); }, fail);
    }
    shell('settings', [head('Settings', 'Workspace-wide: brand, domain, integrations and review policy.'),
      h('div', { class: 'stack' },
        h('div', { class: 'card stack' }, h('h2', null, 'Workspace & brand'),
          h('label', null, 'Name', name),
          h('div', { class: 'row' }, h('label', null, 'Accent colour', accent), h('label', { class: 'grow' }, 'Help-center title', logoText)),
          h('div', null, h('button', { class: 'btn primary', type: 'button', disabled: !admin, onclick: function () { save({ name: name.value, brand: { accent: accent.value, logoText: logoText.value } }); } }, 'Save'))),
        h('div', { class: 'card stack' }, h('h2', null, 'Custom domain'),
          has('custom-domain') ? h('p', { class: 'muted small', style: 'margin:0' }, 'Add a CNAME record pointing your hostname at ', h('code', null, ws.urls.contentHost.split(':')[0]), '. Demos then live at https://<your domain>/<demo>/ and the help center at its root.') : lockCard('Custom domain (help.yourapp.com)', 'Pro'),
          h('label', null, 'Hostname', domain),
          h('div', null, h('button', { class: 'btn primary', type: 'button', disabled: !admin || !has('custom-domain'), onclick: function () { save({ customDomain: domain.value || null }); } }, 'Save domain'))),
        h('div', { class: 'card stack' }, h('h2', null, 'Webhooks'),
          has('webhooks') ? h('p', { class: 'muted small', style: 'margin:0' }, 'Leads, publishes, releases waiting for review and stale guides are POSTed here as JSON. A Slack incoming-webhook URL works as is; Zapier and Make turn it into a CRM sync.') : lockCard('Webhooks for leads, publishes and stale guides', 'Team'),
          h('label', null, 'URL', hook),
          h('div', { class: 'row' },
            h('button', { class: 'btn primary', type: 'button', disabled: !admin || !has('webhooks'), onclick: function () { save({ webhookUrl: hook.value || null }); } }, 'Save'),
            h('button', { class: 'btn', type: 'button', disabled: !admin || !has('webhooks') || !ws.webhookUrl, onclick: function () { save({ webhookUrl: ws.webhookUrl, webhookTest: true }); } }, 'Send test'))),
        h('div', { class: 'card stack' }, h('h2', null, 'Review policy'),
          has('review') ? null : lockCard('Draft releases, review links, comments and approvals', 'Team'),
          h('label', { class: 'row', style: 'font-weight:600;color:var(--ink)' }, review, 'Every publish becomes a draft until an admin approves it'),
          h('div', null, h('button', { class: 'btn primary', type: 'button', disabled: !admin || !has('review'), onclick: function () { save({ requireReview: review.checked }); } }, 'Save policy'))))]);
  }

  function viewBilling() {
    var ws = state.ws;
    var interval = sessionStorage.getItem('vistaro:interval') || 'annual';
    var box = h('div', { class: 'stack' });
    shell('billing', [head('Plan & billing', 'The CLI is free and unlimited, forever. You pay for publishing, measuring and team workflow, never for renders.'), box]);
    function draw() {
      box.textContent = '';
      var p = state.plans;
      var sw = h('div', { class: 'switch', role: 'group', 'aria-label': 'Billing interval' },
        h('button', { type: 'button', 'aria-pressed': String(interval === 'monthly'), onclick: function () { interval = 'monthly'; sessionStorage.setItem('vistaro:interval', interval); draw(); } }, 'Monthly'),
        h('button', { type: 'button', 'aria-pressed': String(interval === 'annual'), onclick: function () { interval = 'annual'; sessionStorage.setItem('vistaro:interval', interval); draw(); } }, 'Annual · save 20%'));
      append(box, [
        h('div', { class: 'row' }, h('span', { class: 'grow' }, 'You are on ', h('strong', null, ws.plan.name), '. ', ws.usage.projects + ' demo(s), ' + ws.usage.seats + ' seat(s) in use.'), sw),
        /upgraded=1/.test(location.hash) ? h('div', { class: 'card' }, '🎉 Thanks! Your plan updates as soon as Stripe confirms the payment (usually a few seconds); refresh if it still shows the old plan.') : null,
        h('div', { class: 'plans' }, p.plans.map(function (pl) {
          var cur = pl.id === ws.plan.id;
          var price = pl.priceMonthly == null ? 'Custom' : pl.priceMonthly === 0 ? '$0' : '$' + (interval === 'annual' ? pl.priceAnnualMonthly : pl.priceMonthly);
          var action;
          if (cur) action = h('span', { class: 'tag ok' }, 'Current plan');
          else if (pl.id === 'enterprise') action = h('a', { class: 'btn', href: 'mailto:sales@vistaro.dev?subject=Vistaro%20Enterprise' }, 'Talk to us');
          else if (pl.id === 'free') action = ws.billing && ws.billing.hasCustomer ? h('button', { class: 'btn', type: 'button', onclick: portal }, 'Downgrade in billing portal') : null;
          else action = h('button', { class: 'btn primary', type: 'button', onclick: function () { checkout(pl.id); } }, 'Upgrade to ' + pl.name);
          var lines = [
            (pl.seats == null ? 'Unlimited' : pl.seats) + ' seat' + (pl.seats === 1 ? '' : 's'),
            (pl.projects == null ? 'Unlimited' : pl.projects) + ' published demos',
            (pl.analyticsDays == null ? 'Unlimited' : pl.analyticsDays + ' days of') + ' analytics',
            (pl.releaseHistory == null ? 'Unlimited' : pl.releaseHistory) + ' releases kept per demo',
          ];
          // Each tier lists what it adds over the one before it, not the whole ladder again.
          var idx = p.plans.indexOf(pl);
          var prev = idx > 0 ? p.plans[idx - 1] : null;
          var added = pl.features.filter(function (f) { return !prev || prev.features.indexOf(f) < 0; });
          if (pl.id === 'free') lines.push('Hosting, embeds and help-center-ready guides', 'Cookieless analytics', '"Made with Vistaro" badge on demos');
          return h('div', { class: 'card plan' + (cur ? ' current' : '') },
            h('h2', null, pl.name),
            h('div', { class: 'price' }, price, pl.priceMonthly ? h('small', null, ' /mo' + (interval === 'annual' ? ', billed yearly' : '')) : null),
            h('ul', null, lines.map(function (l) { return h('li', null, l); })),
            added.length ? h('p', { class: 'small', style: 'margin:0;font-weight:600' }, prev && prev.id !== 'free' ? 'Everything in ' + prev.name + ', plus:' : 'Plus:') : null,
            added.length ? h('ul', null, added.map(function (f) { return h('li', null, p.features[f]); })) : null,
            h('div', null, ws.role === 'owner' ? action : (cur ? action : null)),
            ws.devPlanSwitch && !cur ? h('button', { class: 'btn sm', type: 'button', onclick: function () { api('POST', wsUrl('/billing/dev-plan'), { plan: pl.id }).then(function (w) { state.ws = w; toast('Switched to ' + pl.name + ' (demo mode)'); viewBilling(); }, fail); } }, 'Try ' + pl.name + ' (demo mode)') : null);
        })),
        ws.billing && ws.billing.hasCustomer && ws.role === 'owner' ? h('div', null, h('button', { class: 'btn', type: 'button', onclick: portal }, 'Invoices, card and cancellation')) : null,
        !ws.billingConfigured ? h('p', { class: 'muted small' }, 'Payments are not configured on this server yet (Stripe keys missing), so upgrades answer "billing not configured".') : null,
      ]);
    }
    function checkout(plan) {
      api('POST', wsUrl('/billing/checkout'), { plan: plan, interval: interval }).then(function (r) { location.href = r.url; }, fail);
    }
    function portal() {
      api('POST', wsUrl('/billing/portal'), {}).then(function (r) { location.href = r.url; }, fail);
    }
    (state.plans ? Promise.resolve() : api('GET', '/api/plans').then(function (p) { state.plans = p; })).then(draw, fail);
  }

  function viewAudit() {
    var box = h('div', { class: 'card table-wrap' }, h('p', { class: 'muted' }, 'Loading…'));
    shell('audit', [head('Audit log', 'Who published, approved, rolled back, invited or changed what.'), has('audit-log') ? box : lockCard('Audit log', 'Enterprise')]);
    if (!has('audit-log')) return;
    api('GET', wsUrl('/audit')).then(function (d) {
      box.textContent = '';
      box.appendChild(h('table', null, h('thead', null, h('tr', null, ['When', 'Who', 'What', 'Detail'].map(function (c) { return h('th', null, c); }))),
        h('tbody', null, d.entries.map(function (a) { return h('tr', null, h('td', { class: 'small' }, fmtDate(a.at)), h('td', null, a.actor || 'CI / system'), h('td', { class: 'mono' }, a.action), h('td', { class: 'small muted' }, JSON.stringify(a.detail))); }))));
    }, fail);
  }

  // ---- routing ----------------------------------------------------------------
  function route() {
    if (!state.me) return renderAuth();
    var parts = location.hash.replace(/^#/, '').split('?')[0].split('/');
    var v = parts[0] || 'projects';
    if (v === 'project' && parts[1]) return viewProject(decodeURIComponent(parts[1]), parts[2]);
    var views = { projects: viewProjects, help: viewHelp, team: viewTeam, ci: viewCi, settings: viewSettings, billing: viewBilling, audit: viewAudit };
    (views[v] || viewProjects)();
  }
  addEventListener('hashchange', route);

  function loadWs() {
    return api('GET', wsUrl('')).then(function (w) { state.ws = w; });
  }

  function boot() {
    api('GET', '/api/me').then(function (me) {
      state.me = me;
      var saved = null;
      try { saved = localStorage.getItem('vistaro:ws'); } catch (e) { /* ok */ }
      var slugs = me.workspaces.map(function (w) { return w.slug; });
      state.slug = slugs.indexOf(saved) >= 0 ? saved : slugs[0];
      if (!state.slug) { mount(h('div', { class: 'auth' }, h('div', { class: 'auth-card' }, logo(), h('p', null, 'You are not a member of any workspace.')))); return null; }
      return loadWs().then(route);
    }, function (e) {
      if (e.status === 401) renderAuth();
      else mount(h('div', { class: 'auth' }, h('p', { class: 'err' }, 'Vistaro Cloud is unreachable: ' + e.message)));
    });
  }
  boot();
})();
