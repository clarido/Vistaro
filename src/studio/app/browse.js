// A "Browse…" button for the open-folder dialogs: the File System Access API opens the OS's
// own directory dialog with zero native code. Security trade: the API yields the folder's NAME,
// never its full path -- so picking FILLS the path field as a suggestion and the user confirms
// (the input stays authoritative). Browsers without the API never show the button.
(function () {
  'use strict';
  // The fill rule: keep the typed prefix up to its last separator (either slash kind -- Windows
  // paths use \) and append the folder NAME; with no separator the name replaces the tail.
  function fillPath(existing, name) {
    var m = /[\s\S]*[\/\\]/.exec(existing);
    return (m ? m[0] : '') + name;
  }
  function init() {
    if (!window.showDirectoryPicker) return;
    var buttons = document.querySelectorAll('[data-browse-for]');
    Array.prototype.forEach.call(buttons, function (btn) {
      btn.hidden = false;
      btn.addEventListener('click', function () {
        var input = document.getElementById(btn.getAttribute('data-browse-for'));
        if (!input) return;
        window.showDirectoryPicker({ mode: 'read' }).then(function (handle) {
          // Fill, select, and focus the tail: the fastest confirm is typing the missing middle
          // or just hitting Enter on the suggested absolute prefix the user's own server knows.
          input.value = fillPath(input.value, handle.name);
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
          var err = document.getElementById('open-error');
          if (err) err.hidden = true;
        }).catch(function () { /* user cancelled the OS dialog: nothing to do */ });
      });
    });
  }
  // Guarded so the pure fill rule can be required outside a browser (test/studio.hub-picker.test.ts).
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { fillPath: fillPath };
})();
