// The hub has two moving parts: copy the ask to the clipboard, and open a folder straight
// into the editor (the same POST /api/open the picker's own button uses -- the server
// validates and registers the directory either way).
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  // ---------------------------------------------------------------- copy the ask
  var ask = $('the-ask'), copy = $('copy-ask');
  copy.addEventListener('click', function () {
    var text = ask.textContent;
    var done = function () {
      copy.textContent = 'copied \u2713';
      setTimeout(function () { copy.textContent = 'copy'; }, 1600);
    };
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      // execCommand reports a refusal with a false return, not a throw; confirm only on success.
      try { if (document.execCommand('copy')) done(); } catch (e) { /* the ask stays selectable above */ }
      ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  });

  // ---------------------------------------------------------------- open a folder
  var overlay = $('open-overlay'), form = $('open-form'), input = $('open-path'), err = $('open-error');
  function show() { overlay.hidden = false; err.hidden = true; input.value = ''; input.focus(); }
  function hide() { overlay.hidden = true; }
  $('open-dir').addEventListener('click', show);
  $('open-cancel').addEventListener('click', hide);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) hide(); });
  input.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); hide(); } });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var p = input.value.trim();
    if (!p) { input.focus(); return; }
    err.hidden = true;
    fetch('/api/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p }) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (res.ok) { location.href = '/?project=' + encodeURIComponent(res.data.id); return; }
        err.textContent = res.data.error || 'could not open that directory';
        err.hidden = false;
      })
      .catch(function (e2) {
        err.textContent = 'could not open: ' + e2;
        err.hidden = false;
      });
  });
})();
