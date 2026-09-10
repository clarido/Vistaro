/**
 * <anim-tour> — the documented way to put a tour scenario on someone else's page.
 *
 *   <script type="module" src="https://host/tour/anim-tour.js"></script>
 *   <anim-tour src="https://host/tour/" scenario="draft-response" autoplay="inview"></anim-tour>
 *
 * It is a wrapper around an iframe, not a replacement for one, and that is deliberate. runtime.js
 * owns `document.body`: the camera transforms it, and restart() EMPTIES it and rebuilds it from a
 * boot snapshot. In a shadow-DOM component that last one would delete the host's page. Mockups are
 * also authored in viewport units (100vw, -40vw), which only mean the right thing when the document
 * really is the viewport. So the frame is the isolation primitive and this element is the API.
 *
 * What it adds over a hand-written iframe:
 *   - lazy loading: the frame's src is set only once the element is near the viewport;
 *   - autoplay="inview": play when scrolled into view, pause when it leaves. This CANNOT be done
 *     inside the frame -- an IntersectionObserver there measures against the frame's own viewport
 *     and reports an off-screen embed as fully visible;
 *   - auto-height: the embed page reports its height, so the frame follows its caption;
 *   - device: picks the desktop or mobile page from the HOST's viewport, which is the only place
 *     the real width is known, and re-picks when a rotation crosses the breakpoint;
 *   - prefers-reduced-motion: never autoplays;
 *   - events: `tourstep`, `tourend`, `tourready`, `tourerror` on the element, for analytics.
 *
 * Attributes: src (tour root, required), scenario (required), device (auto|desktop|mobile),
 * autoplay (none|inview|immediate), height (initial px before the page reports its own).
 * Methods: play(), pause(), restart(), next(), prev(), goto(i).
 */
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
const PHONE = matchMedia('(max-width: 768px)');

class AnimTour extends HTMLElement {
    static get observedAttributes() { return ['src', 'scenario', 'device', 'autoplay', 'height']; }

    connectedCallback() {
        // Only the DOM is built once. Everything else is re-established on every connect: moving an
        // element in the DOM (a framework re-render, a tab panel being detached) fires
        // disconnected+connected, and an element that restored nothing would keep rendering its
        // frame while silently losing auto-height, inview autoplay and every event it emits.
        if (!this._frame) {
            this.style.display = 'block';
            this._frame = document.createElement('iframe');
            this._frame.setAttribute('title', this.getAttribute('title') || 'Product tour');
            this._frame.setAttribute('scrolling', 'no');
            this._frame.setAttribute('allowfullscreen', '');
            this._frame.style.cssText = 'display:block;width:100%;border:0;';
            this._frame.style.height = (parseInt(this.getAttribute('height'), 10) || 620) + 'px';
            this.appendChild(this._frame);
        }

        this._onMessage = (e) => this._receive(e);
        addEventListener('message', this._onMessage);
        // A rotation that crosses the breakpoint is a different PAGE, not a restyle, so the frame is
        // reloaded -- the same rule the full shell follows.
        this._onBreakpoint = () => { if ((this.getAttribute('device') || 'auto') === 'auto') this._reload(); };
        if (PHONE.addEventListener) PHONE.addEventListener('change', this._onBreakpoint);

        // Two observers with different thresholds: the frame is loaded early (a blank frame is
        // cheap, a late one is a visible gap) and only played once it is genuinely on screen.
        if ('IntersectionObserver' in window) {
            this._loader = new IntersectionObserver((es) => {
                if (!es.some(e => e.isIntersecting)) return;
                this._loader.disconnect();
                // Reported here rather than in _load(), which is also reached before a
                // framework has set its attributes. By the time the element has scrolled
                // into view a missing scenario is a real misconfiguration.
                if (!this.getAttribute('scenario')) console.error('<anim-tour> needs a scenario attribute');
                this._load();
            }, { rootMargin: '400px' });
            this._loader.observe(this);

            this._player = new IntersectionObserver((es) => {
                for (const e of es) this._visible(e.isIntersecting);
            }, { threshold: 0.4 });
            this._player.observe(this);
        } else {
            this._load();
        }
    }

    disconnectedCallback() {
        // Moving an element in the DOM RELOADS any iframe inside it -- the browser tears the frame's
        // document down and boots it again from src. So the frame that comes back has not sent
        // `ready` yet, and a command issued in between must queue rather than be posted into a
        // document that is on its way out. Leaving this true was a silently dropped play().
        this._ready = false;
        removeEventListener('message', this._onMessage);
        if (PHONE.removeEventListener && this._onBreakpoint) PHONE.removeEventListener('change', this._onBreakpoint);
        if (this._loader) { this._loader.disconnect(); this._loader = undefined; }
        if (this._player) { this._player.disconnect(); this._player = undefined; }
    }

    attributeChangedCallback(name, before, after) {
        // No `before !== null` guard: setting `scenario` for the first time AFTER insertion is the
        // normal shape for a framework-created element, and treating that as "not a change" left the
        // element a blank frame for good.
        if (this._frame && before !== after && (name === 'src' || name === 'scenario' || name === 'device')) this._reload();
    }

    _reload() {
        this._loaded = false;
        this._load();
    }

    get _root() {
        const src = this.getAttribute('src') || './';
        return src.endsWith('/') ? src : src + '/';
    }

    /** The host is the only frame that can see the real viewport, so the device is decided here. */
    _wantedDevice() {
        const want = this.getAttribute('device') || 'auto';
        if (want === 'desktop' || want === 'mobile') return want;
        return PHONE.matches ? 'mobile' : 'desktop';
    }

    /**
     * Which device pages this scenario actually HAS. A tour whose screen is not responsive ships
     * desktop-only (see the tour docs), and asking a phone-shaped host for a mobile page that was
     * never built frames a 404 -- a blank box, on the device where it is least likely to be noticed.
     * tours.json is the same manifest the full shell reads, and it is fetched once per root.
     */
    async _builtDevices(root, scenario) {
        AnimTour._manifests = AnimTour._manifests || {};
        if (!AnimTour._manifests[root]) {
            AnimTour._manifests[root] = fetch(root + 'tours.json')
                .then(r => (r.ok ? r.json() : Promise.reject(new Error('tours.json: HTTP ' + r.status))))
                .catch(() => null);
        }
        const data = await AnimTour._manifests[root];
        const entry = data && (data.scenarios || []).find(s => s.slug === scenario);
        return entry && entry.devices && entry.devices.length ? entry.devices : null;
    }

    async _load() {
        if (this._loaded) return;
        const scenario = this.getAttribute('scenario');
        if (!scenario) return;              // not an error yet: the attribute may arrive in a moment
        this._loaded = true;
        this._ready = false;
        // Every input is captured BEFORE the await and re-checked after it. Two _loads can be in
        // flight at once (src changed while the first manifest was still fetching); without this the
        // slower one finishes last and writes a URL built from one load's root and the other's
        // scenario -- a 404 in a frame, which has no error surface at all.
        const gen = (this._gen = (this._gen || 0) + 1);
        const root = this._root;
        const want = this._wantedDevice();
        // If the manifest cannot be read we still load: the requested device is the best guess, and
        // a tour that renders is better than one that waited for a file it will never get.
        const built = await this._builtDevices(root, scenario);
        if (gen !== this._gen || !this._frame) return;
        const device = !built ? want : (built.includes(want) ? want : built[0]);
        // Autoplay is not carried in the URL: the page's own data-autoplay is baked at build time,
        // and one mechanism that always wins beats two that can disagree. The element asks for play
        // on `ready` instead, which is also the only moment the frame can act on it.
        this._frame.src = `${root}embed-${scenario}-${device}.html`;
    }

    get _autoplay() {
        const mode = this.getAttribute('autoplay') || 'none';
        return REDUCED.matches ? 'none' : mode;      // a demo that moves is exactly what this opts out of
    }

    _visible(on) {
        this._onScreen = on;
        if (this._autoplay !== 'inview' || !this._ready) return;
        this._send(on ? 'play' : 'pause');
    }

    _send(type, extra) {
        // Before `ready` there is nothing listening -- the frame is still about:blank, and
        // postMessage into it succeeds and goes nowhere. An author wiring a "Watch the demo" button
        // to play() would otherwise get silence, permanently, because the lazy loader means the
        // frame may not even have started loading yet.
        if (!this._ready) { this._pending = { type, extra }; this._load(); return; }
        if (!this._frame || !this._frame.contentWindow) return;
        this._frame.contentWindow.postMessage({ source: 'anim-tour-host', type, ...extra }, '*');
    }

    _receive(e) {
        const d = e && e.data;
        if (!d || d.source !== 'anim-tour-embed') return;
        if (!this._frame || e.source !== this._frame.contentWindow) return;   // not our frame
        if (d.type === 'size') {
            if (d.height > 0) this._frame.style.height = d.height + 'px';
            return;
        }
        if (d.type === 'ready') {
            this._ready = true;
            const pending = this._pending;
            this._pending = undefined;
            const mode = this._autoplay;
            // The frame usually finishes loading well after the visibility observer first fired,
            // so the decision to play is taken here rather than when the element scrolled in.
            if (pending) this._send(pending.type, pending.extra);
            else if (mode === 'immediate' || (mode === 'inview' && this._onScreen)) this._send('play');
        }
        const map = { ready: 'tourready', step: 'tourstep', end: 'tourend', error: 'tourerror' };
        const name = map[d.type];
        if (name) this.dispatchEvent(new CustomEvent(name, { detail: d, bubbles: true }));
    }

    play() { this._send('play'); }
    pause() { this._send('pause'); }
    restart() { this._send('restart'); }
    next() { this._send('next'); }
    prev() { this._send('prev'); }
    goto(index) { this._send('goto', { index }); }
}

if (!customElements.get('anim-tour')) customElements.define('anim-tour', AnimTour);
export { AnimTour };
