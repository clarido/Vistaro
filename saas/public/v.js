/*
 * Vistaro viewer script -- injected by Vistaro Cloud into every published page.
 *
 * Measures the demo (view, steps reached, completion, CTA clicks, dwell) and,
 * when the workspace's plan and settings say so, draws the lead-capture gate,
 * the call-to-action button and the "Made with Vistaro" badge.
 *
 * Privacy: no cookies, no fingerprinting, no personal data in events. A visit
 * is a random id in sessionStorage; the only personal data ever sent is what
 * a viewer types into a lead form.
 */
(function () {
  'use strict';
  var cfg = window.__vistaro;
  if (!cfg || window.__vistaroBooted) return;
  window.__vistaroBooted = true;
  // A scenario page inside a Vistaro tour shell is measured by the shell, not twice.
  try { if (window.parent !== window && window.parent.__vistaro) return; } catch (e) { /* cross-origin host page: we are the top */ }

  var started = Date.now();
  var sid = null;
  try { sid = sessionStorage.getItem('vistaro:s'); } catch (e) { /* storage blocked */ }
  if (!sid) {
    sid = 's' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    try { sessionStorage.setItem('vistaro:s', sid); } catch (e) { /* ok */ }
  }

  function send(t, extra) {
    if (!cfg.track) return;
    var ev = { p: cfg.p, r: cfg.r, s: sid, t: t };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) ev[k] = extra[k];
    var body = JSON.stringify(ev);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon('/_v/e', new Blob([body], { type: 'text/plain' }))) return;
    } catch (e) { /* fall through */ }
    try { fetch('/_v/e', { method: 'POST', body: body, keepalive: true, headers: { 'content-type': 'text/plain' } }); } catch (e) { /* offline */ }
  }

  var ref = '';
  try { ref = document.referrer ? new URL(document.referrer).hostname : ''; } catch (e) { /* ignore */ }
  if (ref === location.hostname) ref = '';
  send('view', ref ? { ref: ref } : null);

  var left = false;
  function leave() {
    if (left) return;
    left = true;
    send('leave', { d: Date.now() - started });
  }
  addEventListener('pagehide', leave);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') leave(); });

  var seen = {};
  var completed = {};
  function step(n, label, scenario) {
    var key = (scenario || '') + ':' + n;
    if (seen[key]) return;
    seen[key] = true;
    send('step', { n: n, l: label || '', sc: scenario || undefined });
  }
  function complete(scenario) {
    var key = scenario || '';
    if (completed[key]) return;
    completed[key] = true;
    send('complete', scenario ? { sc: scenario } : null);
    if (cta) cta.classList.add('vst-pulse');
  }

  // ---- tours: the shell hears the scenario frame's 'anim-tour' messages ----
  function scenarioOf(win) {
    var frames = document.getElementsByTagName('iframe');
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow === win) {
        // .src is the resolved absolute URL; the attribute may be relative.
        var m = /(?:^|\/)scenarios\/([^/]+)\//.exec(frames[i].src || frames[i].getAttribute('src') || '');
        return m ? decodeURIComponent(m[1]) : '';
      }
    }
    return '';
  }
  addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || d.source !== 'anim-tour') return;
    var sc = scenarioOf(e.source);
    if (d.type === 'state' && typeof d.index === 'number' && d.index >= 0) step(d.index, d.title, sc);
    else if (d.type === 'end') complete(sc);
  });

  // ---- guides: a step counts once half of its section has been on screen ----
  function watchGuide() {
    var sections = document.querySelectorAll('section.step');
    if (!sections.length || !('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var i = Array.prototype.indexOf.call(sections, en.target);
        var h = en.target.querySelector('h2, h3');
        step(i, h ? h.textContent.trim() : '');
        if (i === sections.length - 1) complete();
        io.unobserve(en.target);
      });
    }, { threshold: 0.5 });
    sections.forEach(function (s) { io.observe(s); });
  }

  // ---- videos: watched to the end ----
  function watchVideos() {
    var vids = document.getElementsByTagName('video');
    for (var i = 0; i < vids.length; i++) vids[i].addEventListener('ended', function () { complete(); });
  }

  // ---- chrome: badge, CTA, gate ----
  var cta = null;
  function css() {
    var s = document.createElement('style');
    var a = /^#[0-9a-f]{3,8}$/i.test(cfg.accent || '') ? cfg.accent : '#E4632B';
    s.textContent =
      '.vst-badge{position:fixed;right:12px;bottom:12px;z-index:2147483000;font:600 12px/1 system-ui,sans-serif;background:#0B101B;color:#fff;padding:8px 10px;border-radius:99px;text-decoration:none;box-shadow:0 4px 14px rgba(0,0,0,.25);opacity:.92}' +
      '.vst-badge:hover{opacity:1}.vst-badge b{color:' + a + '}' +
      '.vst-cta{position:fixed;left:12px;bottom:12px;z-index:2147483000;font:600 14px/1 system-ui,sans-serif;background:' + a + ';color:#fff;padding:12px 16px;border-radius:10px;text-decoration:none;box-shadow:0 6px 18px rgba(0,0,0,.25)}' +
      '.vst-pulse{animation:vst-p 1.2s ease-in-out 3}@keyframes vst-p{50%{transform:scale(1.07)}}' +
      '@media (prefers-reduced-motion:reduce){.vst-pulse{animation:none}}' +
      '.vst-gate{position:fixed;inset:0;z-index:2147483600;background:rgba(11,16,27,.72);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:16px}' +
      '.vst-gate form{background:#fff;color:#0f172a;border-radius:16px;padding:24px;max-width:380px;width:100%;display:grid;gap:12px;font:15px/1.5 system-ui,sans-serif;box-shadow:0 20px 50px rgba(0,0,0,.35)}' +
      '.vst-gate h2{margin:0;font-size:19px}.vst-gate input{padding:11px 12px;border:1px solid #cbd5e1;border-radius:9px;font:inherit}' +
      '.vst-gate button{padding:12px;border:0;border-radius:9px;background:' + a + ';color:#fff;font:600 15px system-ui,sans-serif;cursor:pointer}' +
      '.vst-gate .vst-err{color:#b91c1c;font-size:13px;min-height:1em;margin:0}' +
      '.vst-preview{position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483000;background:#fbbf24;color:#1a1300;font:600 12px system-ui,sans-serif;padding:6px 12px;border-radius:0 0 8px 8px}';
    document.head.appendChild(s);
  }

  function chrome() {
    css();
    if (cfg.preview) {
      var pv = document.createElement('div');
      pv.className = 'vst-preview';
      pv.textContent = 'Preview of release #' + cfg.r + ' (not live)';
      document.body.appendChild(pv);
    }
    if (cfg.badge) {
      var b = document.createElement('a');
      b.className = 'vst-badge';
      b.href = 'https://vistaro.dev/?ref=badge';
      b.target = '_blank';
      b.rel = 'noopener';
      b.innerHTML = 'Made with <b>Vistaro</b>';
      document.body.appendChild(b);
    }
    if (cfg.cta && /^https?:\/\//.test(cfg.cta.url)) {
      cta = document.createElement('a');
      cta.className = 'vst-cta';
      cta.href = cfg.cta.url;
      cta.target = '_blank';
      cta.rel = 'noopener';
      cta.textContent = cfg.cta.label;
      cta.addEventListener('click', function () { send('cta'); });
      document.body.appendChild(cta);
    }
    if (cfg.gate) gate();
  }

  function gate() {
    var key = 'vistaro:lead:' + cfg.p;
    try { if (localStorage.getItem(key)) return; } catch (e) { /* show it */ }
    var wrap = document.createElement('div');
    wrap.className = 'vst-gate';
    var f = document.createElement('form');
    var h = document.createElement('h2');
    h.textContent = cfg.gate.headline || 'Enter your email to watch the demo';
    f.appendChild(h);
    var labels = { email: 'Work email', name: 'Name', company: 'Company' };
    cfg.gate.fields.forEach(function (name) {
      var i = document.createElement('input');
      i.name = name;
      i.placeholder = labels[name] || name;
      i.setAttribute('aria-label', labels[name] || name);
      if (name === 'email') { i.type = 'email'; i.required = true; i.autocomplete = 'email'; }
      f.appendChild(i);
    });
    var err = document.createElement('p');
    err.className = 'vst-err';
    var btn = document.createElement('button');
    btn.type = 'submit';
    btn.textContent = 'Watch the demo';
    f.appendChild(btn);
    f.appendChild(err);
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = { p: cfg.p, s: sid, ref: ref };
      cfg.gate.fields.forEach(function (n) { data[n] = f.elements[n].value; });
      btn.disabled = true;
      fetch('/_v/lead', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
        .then(function (r) {
          if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || 'failed'); });
          try { localStorage.setItem(key, '1'); } catch (e2) { /* ok */ }
          wrap.parentNode.removeChild(wrap);
        })
        .catch(function (e3) { err.textContent = e3.message; btn.disabled = false; });
    });
    wrap.appendChild(f);
    document.body.appendChild(wrap);
    var first = f.querySelector('input');
    if (first) first.focus();
  }

  function boot() {
    chrome();
    if (cfg.kind === 'guide') watchGuide();
    watchVideos();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
