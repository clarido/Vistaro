/**
 * In-page scheduler for the tour shell (plain browser JS, injected as text next to runtime.js).
 *
 * runtime.js ships two schedulers already: the timed one inside `play()` (a page that plays itself)
 * and the Node-side one in driver.ts (Playwright). Neither can be seeked, because both advance on a
 * clock. A tour needs a third: one step at a time, driven by messages from the parent frame, so the
 * shell can offer play/pause and per-step navigation.
 *
 * Seeking works by replaying rather than rewinding: __anim.restart() puts the authored DOM back,
 * every earlier step is re-run with {instant: true} (which every duration-bearing action honours),
 * and the requested step then plays at full speed. That is why the page always agrees with itself --
 * there is no separate "state at step N" to drift out of sync.
 *
 * Protocol, both ways, on window.postMessage with source 'anim-tour':
 *   in : {type:'play'|'pause'|'next'|'prev'|'restart'} | {type:'goto', index:n}
 *   out: {type:'ready', total, steps} | {type:'state', index, playing, ...} | {type:'end'} | {type:'error', index, message}
 * `play` while already playing is a no-op (it would otherwise start the NEXT step on top of the one
 * still running); `pause` cancels the in-flight step, runtime timers and all, and a following `play`
 * replays that step from its beginning instead of skipping past it; an `error` REPLACES the state
 * message for its turn -- a state right after it overwrote the caption before anyone could read it.
 */
(function () {
  var steps = [], meta = {}, playing = false, index = -1;
  var seq = 0;            // bumped by every seek; an in-flight run whose token is stale gives up
  var inFlight = false;   // a runStep is animating right now (pause must stop it, resume must replay it)
  var seeking = false;    // a seek's instant replay is between steps (inFlight is false in the gaps)
  // Pause struck while a step was in flight (or a seek half-done). inFlight alone is not enough to
  // resume by replay: camera/fade/transitionScreen/animate steps complete through timers and
  // animations that __anim.stop() cannot cancel (a CSS transition keeps painting), so their
  // completion resolves after the pause and clears inFlight -- the step is still the one to replay.
  var pausedMidStep = false;
  var timer = null;
  var reduced = false;

  // The shell (or an embed page) that frames this scenario is served from the same origin, so the
  // wildcard is not needed there. It stays as the fallback for file://, where Chromium reports an
  // origin of "file://" -- a string that LOOKS usable but can never match the receiving window's
  // opaque origin, so a message sent to it is dropped with no error anywhere.
  var UP = (location.protocol !== 'file:' && location.origin && location.origin !== 'null') ? location.origin : '*';

  function post(type, extra) {
    var msg = { source: 'anim-tour', type: type };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) msg[k] = extra[k];
    try { parent.postMessage(msg, UP); } catch (e) { /* not framed */ }
  }

  function timeMs(s) {
    if (!s) return 0;
    if (typeof s.timeMs === 'number') return s.timeMs;
    var t = s.time;
    if (typeof t === 'number') return t * 1000;
    if (typeof t !== 'string') return 0;
    var m = /^([\d.]+)\s*(ms|s)?$/.exec(t.trim());
    if (!m) return 0;
    return m[2] === 'ms' ? parseFloat(m[1]) : parseFloat(m[1]) * 1000;
  }

  /**
   * Dwell after step i. The authored distance to the next step already contains that step's cursor
   * lead (runtime.js re-runs it), so the lead is subtracted rather than paid twice; the floor keeps
   * a tightly-authored timeline readable when a viewer is reading captions instead of watching.
   */
  function gapAfter(i) {
    if (i + 1 >= steps.length) return meta.tailMs != null ? meta.tailMs : 2500;
    var span = timeMs(steps[i + 1]) - timeMs(steps[i]);
    return Math.max(450, span - Math.min(950, span));
  }

  function clearTimer() { if (timer) { clearTimeout(timer); timer = null; } }

  function emit() {
    var s = steps[index] || {};
    post('state', {
      index: index, total: steps.length, playing: playing,
      id: s.id, action: s.action, title: s.title || '', subtitle: s.subtitle || '', note: s.note || '',
    });
  }

  function settle() {
    // runStep resolves at the interaction; a fade/camera/typing is only over at its completion.
    return window.__anim.whenIdle();
  }

  function runOne(i, instant) {
    // inFlight spans the WHOLE step (runStep resolves at the interaction; typing/camera/fades keep
    // animating until settle()/whenIdle), because pause must stop an animating step and a resume
    // must replay it -- not merely one whose first keystroke has landed.
    inFlight = true;
    var done = window.__anim.runStep(steps[i], { instant: !!instant || reduced }).then(settle);
    done.then(function () { inFlight = false; }, function () { inFlight = false; });
    return done;
  }

  /** Play step i in place (no rewind), then queue the next one while still playing. */
  function advance(token, i) {
    if (token !== seq || i >= steps.length) return;
    seeking = false; // the replay that led here is over; only the step itself is (or soon is) in flight
    pausedMidStep = false; // this step starts clean from an authored state; a pause in it re-arms the flag
    index = i;
    emit();
    runOne(i, false).then(function () {
      if (token !== seq) return;
      if (!playing) { emit(); return; }
      clearTimer();
      timer = setTimeout(function () {
        if (token !== seq) return;
        if (i + 1 < steps.length) advance(token, i + 1);
        else { playing = false; emit(); post('end'); }
      }, gapAfter(i));
    }, function (e) {
      // A step can reject (a selector that no longer matches). Leaving `playing` true freezes the
      // shell showing a tour that is not playing, so stop and say so. No state follows an error:
      // the shell's error handler is the whole message for this turn.
      if (token !== seq) return;
      playing = false;
      post('error', { index: i, message: String(e && e.message || e) });
    });
  }

  /** Rewind and replay up to `n` instantly, then play `n` itself. */
  function seek(n) {
    n = Math.max(0, Math.min(steps.length - 1, n));
    // The destination is known now; advance() re-asserts it. Without this, a command arriving
    // during the instant replay (a play queued behind the goto that started it) read the index of
    // the step BEFORE the seek and re-seeked to the wrong place.
    index = n;
    seq++;
    seeking = true;
    var token = seq;
    clearTimer();
    window.__anim.restart();
    var chain = Promise.resolve();
    for (var i = 0; i < n; i++) (function (k) {
      chain = chain.then(function () { if (token === seq) return runOne(k, true); });
    })(i);
    chain.then(function () { if (token === seq) advance(token, n); }, function (e) {
      // Without this handler a rejection anywhere in the instant replay swallows the whole seek:
      // advance() is never reached and nothing is posted, so the shell waits forever.
      if (token !== seq) return;
      seeking = false;
      playing = false;
      post('error', { index: n, message: String(e && e.message || e) });
    });
  }

  function handle(d) {
    if (!d || d.source !== 'anim-tour') return;
    // An empty timeline still answers every command: without this the bridge posted nothing at
    // all, and the shell's controls sat enabled but dead forever (no state, no end).
    if (!steps.length) {
      if (d.type === 'play' || d.type === 'pause' || d.type === 'next' || d.type === 'prev' || d.type === 'goto' || d.type === 'restart') {
        playing = false;
        post('end');
      }
      return;
    }
    switch (d.type) {
      case 'play':
        // Already playing: a second play would orphan the running step and start the next one on
        // top of it (two interactions, the cursor fought over by two moves).
        if (playing) return;
        playing = true;
        // Mid-step, between the steps of a seek's instant replay, or paused mid-step (the step's
        // completion may have resolved after the pause -- see pausedMidStep): resume by replaying
        // the destination. Taking the advance(index + 1) branch inside that window would abandon
        // the seek half-done and skip past the step the viewer asked for.
        if (inFlight || seeking || pausedMidStep) { pausedMidStep = false; seek(index); break; }
        if (index < 0) seek(0);
        else if (index + 1 < steps.length) { seq++; advance(seq, index + 1); }
        else seek(0);
        break;
      case 'pause':
        playing = false; seq++; clearTimer();
        // Whether or not the interrupted step's completion resolves later, the next play must
        // replay THIS step: arm the replay flag for in-flight steps and half-done seeks alike.
        if (inFlight || seeking) pausedMidStep = true;
        seeking = false;
        // clearTimer() only stops the bridge's own dwell timer. The runtime's timers (cursor
        // travel, typing, the interaction itself) must be cancelled too, or a paused tour keeps
        // typing and still clicks. The stalled runStep promise is abandoned on purpose: resume
        // goes through seek(), and restart() resets the completions it would ever resolve into.
        // (A camera/fade transition itself cannot be frozen by stop(); its completion resolves
        // harmlessly into a stale token, and pausedMidStep is what makes the resume replay.)
        if (inFlight) { try { window.__anim.stop(); } catch (e) { /* not booted */ } }
        emit();
        break;
      case 'next':
        playing = false; clearTimer(); seek(index + 1);
        break;
      case 'prev':
        playing = false; clearTimer(); seek(index - 1);
        break;
      case 'goto':
        clearTimer(); seek(typeof d.index === 'number' ? d.index : 0);
        break;
      case 'restart':
        playing = true; seek(0);
        break;
    }
  }

  // Only the frame that embeds this page may drive it. Without this, any script on the top-level
  // customer page can reach the scenario window (frames[0].frames[0]) and step it directly, behind
  // the shell's back -- harmless to a mockup, but the inbound half should match the outbound one.
  window.addEventListener('message', function (e) {
    if (e.source !== parent) return;
    handle(e && e.data);
  });

  window.__tour = {
    version: 1,
    boot: function (payload) {
      steps = (payload && payload.steps) || [];
      meta = (payload && payload.meta) || {};
      try { reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { reduced = false; }
      window.__anim.start(0);
      // The shell decides what to show and when to start; the page only announces it is ready.
      post('ready', {
        total: steps.length,
        steps: steps.map(function (s, i) {
          return { index: i, id: s.id, action: s.action, title: s.title || '', subtitle: s.subtitle || '',
                   note: s.note || '', hidden: s.guide === false || !s.title, timeMs: timeMs(s) };
        }),
      });
      // A scenario with no steps would otherwise leave the protocol silent: enabled buttons that
      // do nothing, and an autoplaying embed whose veil never lifts.
      if (!steps.length) post('end');
    },
    state: function () { return { index: index, playing: playing, total: steps.length }; },
  };
})();
