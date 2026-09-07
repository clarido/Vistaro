import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { parseTimeline, loadTimeline } from '../src/engine/schema';
import { extractStrings, applyStrings, resolveLocale, writeStrings, readStrings, isLocaleCode, diffStrings } from '../src/engine/strings';
import { locateLocaleDir, localeDirFor } from '../src/catalog';
import { narrationOf } from '../src/media/tts';

const root = path.resolve(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'basic');
const cli = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'cli.ts', ...args], { cwd: root, encoding: 'utf8' });

const sample = () => parseTimeline({
    meta: { title: 'Draft a proposal', locale: 'en' },
    steps: [
        { id: 'intro', time: 0, action: 'wait', title: 'Overview', subtitle: 'Reviewing.', narration: 'Start here.', note: 'A note.' },
        { id: 'draft', time: 2, action: 'type', target: '#e', value: 'We will comply.', translatable: true, subtitle: 'Drafting.' },
        { id: 'zoom', time: 3, action: 'camera', scale: 1.2 },
        { id: 'fixed', time: 4, action: 'type', target: '#f', value: 'admin@example.com', title: 'Fixed value' },
    ],
});

test('extractStrings keys every translatable field; value only when translatable', () => {
    const s = extractStrings(sample());
    assert.deepEqual(s, {
        'meta.title': 'Draft a proposal',
        'steps.intro.title': 'Overview', 'steps.intro.subtitle': 'Reviewing.', 'steps.intro.narration': 'Start here.', 'steps.intro.note': 'A note.',
        'steps.draft.value': 'We will comply.', 'steps.draft.subtitle': 'Drafting.',
        'steps.fixed.title': 'Fixed value',
    });
});

test('applyStrings overlays translations, falls back to inline text, reports unknown/missing keys', () => {
    const tl = sample();
    const report = applyStrings(tl, {
        'meta.title': 'Rédiger une proposition',
        'steps.intro.subtitle': 'Vérification.',
        'steps.intro.narration': '',
        'steps.draft.value': 'Nous nous conformerons.',
        'steps.fixed.value': 'root@example.com',
        'steps.nope.title': 'x',
        'steps.zoom.title': 'Zoom avant',
    });
    assert.equal(tl.meta.title, 'Rédiger une proposition');
    assert.equal(tl.steps[0].subtitle, 'Vérification.');
    assert.equal(tl.steps[0].narration, 'Start here.', 'empty translation keeps the inline text');
    assert.equal(tl.steps[0].title, 'Overview', 'missing key keeps the inline text');
    assert.equal(tl.steps[1].value, 'Nous nous conformerons.');
    assert.equal(tl.steps[3].value, 'admin@example.com', 'non-translatable value is never overridden');
    assert.equal(tl.steps[2].title, 'Zoom avant', 'a translation for a field with no inline text is still applied');
    assert.deepEqual(report.unknown.sort(), ['steps.fixed.value', 'steps.nope.title']);
    assert.ok(report.missing.includes('steps.intro.title') && report.missing.includes('steps.intro.narration'));
    assert.ok(report.applied.includes('steps.draft.value'));
    assert.equal(narrationOf(tl.steps[0]), 'Start here.');
    // round trip: extract -> apply(extracted) is a no-op
    const again = sample();
    applyStrings(again, extractStrings(again));
    assert.deepEqual(extractStrings(again), extractStrings(sample()));
});

test('resolveLocale precedence: requested > manifest > meta', () => {
    assert.equal(resolveLocale('de', 'fr', 'en'), 'de');
    assert.equal(resolveLocale(undefined, 'fr', 'en'), 'fr');
    assert.equal(resolveLocale(undefined, undefined, 'en'), 'en');
    assert.equal(resolveLocale(undefined, undefined, undefined), undefined);
});

test('loadTimeline applies strings.<locale>.json for the resolved locale', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-strings-'));
    fs.writeFileSync(path.join(d, 'anim.config.json'), JSON.stringify({ meta: { title: 'T', locale: 'en' }, steps: [{ id: 'a', time: 0, action: 'wait', subtitle: 'Hello' }] }));
    writeStrings(path.join(d, 'strings.fr.json'), { 'steps.a.subtitle': 'Bonjour', 'steps.b.subtitle': 'stray' });
    writeStrings(path.join(d, 'strings.en.json'), { 'steps.a.subtitle': 'Hello there' });
    assert.equal(loadTimeline(d).steps[0].subtitle, 'Hello there', 'meta.locale en -> strings.en.json');
    const fr = loadTimeline(d, { locale: 'fr' });
    assert.equal(fr.steps[0].subtitle, 'Bonjour');
    assert.equal(fr.locale, 'fr');
    assert.deepEqual(fr.strings!.unknown, ['steps.b.subtitle']);
    fs.writeFileSync(path.join(d, 'anim.manifest.json'), JSON.stringify({ locale: 'fr', history: [] }));
    assert.equal(loadTimeline(d).steps[0].subtitle, 'Bonjour', 'manifest locale wins over meta.locale');
    assert.equal(loadTimeline(d, { locale: 'de' }).steps[0].subtitle, 'Hello', 'no strings.de.json -> inline text');
    fs.rmSync(d, { recursive: true, force: true });
});

test('localize scaffolds locales/<code>/ with copies, base + target strings, manifest locale; build/check use the strings', () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-localize-'));
    const dir = path.join(work, 'guide');
    fs.cpSync(fixture, dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'shot.png'), 'png');
    fs.writeFileSync(path.join(dir, 'preview.png'), 'generated');
    fs.writeFileSync(path.join(dir, 'unreferenced.png'), 'stray');
    fs.appendFileSync(path.join(dir, 'index.html'), '<img src="shot.png">');
    const r = cli(['localize', dir, 'fr']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const fr = path.join(dir, 'locales', 'fr');
    assert.ok(fs.existsSync(path.join(fr, 'index.html')));
    assert.ok(fs.existsSync(path.join(fr, 'anim.config.json')));
    assert.ok(fs.existsSync(path.join(fr, 'shot.png')), 'referenced media copied');
    assert.ok(!fs.existsSync(path.join(fr, 'preview.png')) && !fs.existsSync(path.join(fr, 'unreferenced.png')), 'generated/unreferenced files are not copied');
    assert.ok(!fs.existsSync(path.join(fr, 'locales')), 'locales/ is never copied into itself');
    const base = readStrings(path.join(dir, 'strings.en.json'));
    const target = readStrings(path.join(fr, 'strings.fr.json'));
    assert.deepEqual(target, base, 'target strings pre-filled with the base text');
    assert.equal(base['steps.open.title'], 'Open the panel');
    assert.equal(base['steps.open.subtitle'], 'Open it.');
    const manifest = JSON.parse(fs.readFileSync(path.join(fr, 'anim.manifest.json'), 'utf8'));
    assert.equal(manifest.locale, 'fr');
    assert.equal(manifest.baseLocale, 'en');
    assert.match(r.stdout, /Translate the values in .*strings\.fr\.json/);

    // translate two strings and one visible text, then build: the built timeline carries the French text
    target['steps.open.subtitle'] = 'Ouvrez-le.';
    target['steps.open.title'] = 'Ouvrir le panneau';
    target['steps.bogus.title'] = 'x';
    writeStrings(path.join(fr, 'strings.fr.json'), target);
    const b = cli(['build', fr]);
    assert.equal(b.status, 0, b.stderr);
    const html = fs.readFileSync(path.join(fr, 'animated.html'), 'utf8');
    assert.ok(html.includes('Ouvrez-le.'), 'French subtitle in the built page');
    assert.ok(!html.includes('"subtitle":"Open it."'));
    const c = cli(['check', fr, '--static']);
    assert.equal(c.status, 0, c.stderr + c.stdout);
    assert.match(c.stdout, /warning  strings\.fr\.json: key "steps\.bogus\.title" matches no step/);
    assert.match(c.stdout, /info {3}.*still identical to the source text/);
    // --locale on the source dir renders the source with a strings file of that locale, when present
    fs.copyFileSync(path.join(fr, 'strings.fr.json'), path.join(dir, 'strings.fr.json'));
    const src = cli(['build', dir, '--locale', 'fr', '-o', path.join(work, 'src-fr.html')]);
    assert.equal(src.status, 0, src.stderr);
    assert.ok(fs.readFileSync(path.join(work, 'src-fr.html'), 'utf8').includes('Ouvrez-le.'));
    // a translator's edits to the target index.html and config survive a re-run (blocker fix)
    fs.appendFileSync(path.join(fr, 'index.html'), '<!-- traduit -->');
    const cfgFr = JSON.parse(fs.readFileSync(path.join(fr, 'anim.config.json'), 'utf8'));
    cfgFr.meta.note = 'edited in the locale';
    fs.writeFileSync(path.join(fr, 'anim.config.json'), JSON.stringify(cfgFr));
    // re-running localize merges (keeps translations, adds new keys) unless --force
    fs.writeFileSync(path.join(dir, 'anim.config.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(dir, 'anim.config.json'), 'utf8')), steps: [...JSON.parse(fs.readFileSync(path.join(dir, 'anim.config.json'), 'utf8')).steps, { id: 'extra', time: 6, action: 'wait', title: 'Extra' }] }));
    const again = cli(['localize', dir, 'fr']);
    assert.equal(again.status, 0, again.stderr);
    const merged = readStrings(path.join(fr, 'strings.fr.json'));
    assert.equal(merged['steps.open.subtitle'], 'Ouvrez-le.', 'translation kept');
    assert.equal(merged['steps.extra.title'], 'Extra', 'new key added');
    assert.ok(fs.readFileSync(path.join(fr, 'index.html'), 'utf8').includes('<!-- traduit -->'), 'translated index.html kept');
    assert.equal(JSON.parse(fs.readFileSync(path.join(fr, 'anim.config.json'), 'utf8')).meta.note, 'edited in the locale', 'edited config kept');
    assert.match(again.stdout, /Kept existing index\.html/);
    assert.match(again.stdout, /Base strings changed since the last run[\s\S]*\+ steps\.extra\.title/);
    assert.equal(readStrings(path.join(dir, 'strings.en.json'))['steps.extra.title'], 'Extra', 'base strings regenerated');
    // manifest events of a locale build record the resolved locale, not the source meta.locale
    const bFr = cli(['build', fr]);
    assert.equal(bFr.status, 0, bFr.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(fr, 'anim.manifest.json'), 'utf8')).history.at(-1).locale, 'fr');
    // --force overwrites the target files
    const forced = cli(['localize', dir, 'fr', '--force']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.ok(!fs.readFileSync(path.join(fr, 'index.html'), 'utf8').includes('<!-- traduit -->'), '--force overwrote index.html');
    assert.match(forced.stderr, /Overwrote existing index\.html \(--force\)/);
    assert.match(forced.stderr, /Overwrote existing anim\.config\.json \(--force\)/);
    assert.match(forced.stderr, /Overwrote existing strings\.fr\.json \(translations lost\) \(--force\)/);
    assert.equal(readStrings(path.join(fr, 'strings.fr.json'))['steps.open.subtitle'], 'Open it.', '--force reset the strings');
    // locateLocaleDir finds the locales/<code> layout; an absent locale reports why
    const guide = { slug: 'g', dir };
    assert.equal(locateLocaleDir(guide, 'fr', 'en').dir, path.join(dir, 'locales', 'fr'));
    assert.match(locateLocaleDir(guide, 'de', 'en').error || '', /no directory for locale "de"/);
    assert.equal(localeDirFor(dir, 'de'), path.join(dir, 'locales', 'de'));
    // legacy sibling layout still available
    const sib = cli(['localize', dir, 'es', '--sibling']);
    assert.equal(sib.status, 0, sib.stderr);
    assert.ok(fs.existsSync(path.join(work, 'es', 'strings.es.json')));
    assert.equal(locateLocaleDir(guide, 'es', 'en').dir, path.join(work, 'es'), 'the legacy sibling layout still resolves');
    // fr -> fr-CA: values seeded from the French view, no strings.en.json written into the fr dir
    writeStrings(path.join(fr, 'strings.fr.json'), { ...readStrings(path.join(fr, 'strings.fr.json')), 'steps.open.subtitle': 'Ouvrez-le.' });
    const ca = cli(['localize', fr, 'fr-CA']);
    assert.equal(ca.status, 0, ca.stderr + ca.stdout);
    const caStrings = readStrings(path.join(fr, 'locales', 'fr-CA', 'strings.fr-CA.json'));
    assert.equal(caStrings['steps.open.subtitle'], 'Ouvrez-le.', 'seeded from the localized source');
    assert.ok(!fs.existsSync(path.join(fr, 'strings.en.json')), 'a locale dir gets no base strings file');
    assert.equal(JSON.parse(fs.readFileSync(path.join(fr, 'locales', 'fr-CA', 'anim.manifest.json'), 'utf8')).baseLocale, 'en');
    fs.rmSync(work, { recursive: true, force: true });
});

test('strings edge cases: invalid JSON names the strings file, dotted ids, locale code validation, legacy baseLocale ignored', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-strings-edge-'));
    fs.writeFileSync(path.join(d, 'anim.config.json'), JSON.stringify({ meta: { locale: 'en' }, steps: [{ id: 'a.b', time: 0, action: 'wait', subtitle: 'Hi' }, { time: 1, action: 'wait', subtitle: 'Auto id' }] }));
    fs.writeFileSync(path.join(d, 'strings.fr.json'), '{ not json');
    assert.throws(() => loadTimeline(d, { locale: 'fr' }), /strings\.fr\.json: invalid JSON/);
    writeStrings(path.join(d, 'strings.fr.json'), { 'steps.a.b.subtitle': 'Salut', 'steps.step-02.subtitle': 'Id auto' });
    const tl = loadTimeline(d, { locale: 'fr' });
    assert.equal(tl.steps[0].subtitle, 'Salut', 'ids containing dots work');
    assert.equal(tl.steps[1].subtitle, 'Id auto');
    assert.deepEqual(tl.strings!.unknown, []);
    // check warns about the auto-generated id in a localized dir
    const c = cli(['check', d, '--static', '--locale', 'fr']);
    assert.match(c.stdout, /auto-generated ids \(step-02\)/);
    // legacy manifest baseLocale holding a directory name is not trusted
    fs.writeFileSync(path.join(d, 'anim.manifest.json'), JSON.stringify({ locale: 'fr', baseLocale: 'my-guide-dir', history: [] }));
    assert.equal(loadTimeline(d).baseLocale, 'en');
    assert.equal(loadTimeline(d).locale, 'fr');
    assert.ok(isLocaleCode('fr') && isLocaleCode('pt-BR') && isLocaleCode('zh-Hant-TW'));
    assert.ok(!isLocaleCode('my-guide-dir') && !isLocaleCode('EN') && !isLocaleCode('locales'));
    assert.deepEqual(diffStrings({ a: '1', b: '2' }, { b: '3', c: '4' }), { added: ['c'], removed: ['a'], changed: ['b'] });
    fs.rmSync(d, { recursive: true, force: true });
});
