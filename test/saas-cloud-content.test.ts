import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { loadSaas, zipOf } from './saas-cloud-helpers';

// Unit tests for the small pure pieces of the content origin and the API:
// HTML injection, the rate limiter, the CSV formula guard, webhook URL rules,
// the notifier's plan gate, and the ZIP writer round-tripping through the
// Cloud's own hand-written reader (saas/lib/zip.js).

test('injectIntoHtml puts the viewer snippet before the LAST </body>, or appends it', async () => {
    const { injectIntoHtml } = await loadSaas('cloud/content.js');
    assert.equal(injectIntoHtml('<p>"</body>" in text</p></BODY>', '<x>'), '<p>"</body>" in text</p><x></BODY>');
    assert.equal(injectIntoHtml('<p>fragment</p>', '<x>'), '<p>fragment</p><x>');
});

test('inlineJson cannot close the script element it is inlined into', async () => {
    const { inlineJson } = await loadSaas('cloud/util.js');
    const out = inlineJson({ title: '</script><script>alert(1)</script>', sep: 'a b' });
    assert.ok(!out.includes('</script'), out);
    assert.ok(!out.includes(' '));
    assert.deepEqual(JSON.parse(out), { title: '</script><script>alert(1)</script>', sep: 'a b' });
});

test('RateLimiter allows `limit` hits per window per key', async () => {
    const { RateLimiter } = await loadSaas('cloud/content.js');
    let now = 0;
    const rl = new RateLimiter({ limit: 2, windowMs: 1000, now: () => now });
    assert.deepEqual([rl.allow('a'), rl.allow('a'), rl.allow('a'), rl.allow('b')], [true, true, false, true]);
    now = 1000;
    assert.equal(rl.allow('a'), true, 'a new window resets the count');
});

test('csvCell quotes separators and defuses spreadsheet formulas', async () => {
    const { csvCell } = await loadSaas('cloud/api.js');
    assert.equal(csvCell('plain'), 'plain');
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
    assert.equal(csvCell('+1'), "'+1");
    assert.equal(csvCell(null), '');
});

test('webhook URLs must be https without credentials; http only when the operator allows it', async () => {
    const { validWebhookUrl } = await loadSaas('cloud/notify.js');
    assert.equal(validWebhookUrl('https://hooks.slack.com/services/x'), true);
    assert.equal(validWebhookUrl('http://hooks.example.com/x'), false);
    assert.equal(validWebhookUrl('http://localhost:9/x', { allowHttp: true }), true);
    assert.equal(validWebhookUrl('https://user:pw@example.com/x'), false);
    assert.equal(validWebhookUrl('file:///etc/passwd', { allowHttp: true }), false);
    assert.equal(validWebhookUrl('not a url'), false);
});

test('the notifier only delivers for plans with webhooks, as Slack-compatible JSON', async () => {
    const { Notifier } = await loadSaas('cloud/notify.js');
    const sent: Array<{ url: string; body: { event: string; text: string; data: unknown } }> = [];
    const n = new Notifier({ fetchImpl: async (url: string, init: { body: string }) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response('ok'); } });
    assert.equal(n.send({ slug: 'w', plan: 'pro', webhookUrl: 'https://h.test/x' }, 'lead.created', 'hi'), null, 'pro has no webhooks');
    assert.equal(n.send({ slug: 'w', plan: 'team', webhookUrl: null }, 'lead.created', 'hi'), null);
    await n.send({ slug: 'w', plan: 'team', webhookUrl: 'https://h.test/x' }, 'lead.created', 'New lead', { email: 'a@b.co' });
    await n.drain();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'https://h.test/x');
    assert.equal(sent[0].body.event, 'lead.created');
    assert.equal(sent[0].body.text, '[Vistaro] New lead');
    assert.deepEqual(sent[0].body.data, { email: 'a@b.co' });
});

test('a failing webhook receiver never throws into the caller', async () => {
    const { Notifier } = await loadSaas('cloud/notify.js');
    const logs: string[] = [];
    const n = new Notifier({ log: (l: string) => logs.push(l), fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    const ok = await n.send({ slug: 'w', plan: 'team', webhookUrl: 'https://h.test/x' }, 'x', 'y');
    assert.equal(ok, false);
    assert.match(logs[0], /ECONNREFUSED/);
});

test('zipwrite round-trips through the Cloud reader, stored and deflated entries alike', async () => {
    const { extractZip } = await loadSaas('zip.js');
    const big = 'x'.repeat(5000);
    const media = Buffer.alloc(300, 7);
    const zip = await zipOf({ 'a/b.html': big, 'clip.mp4': media, 'é.txt': 'utf8 name' });
    const { entries } = extractZip(zip);
    const files = Object.fromEntries(entries.filter((e: { type: string }) => e.type === 'file').map((e: { name: string; data: Buffer }) => [e.name, e.data]));
    assert.equal(files['a/b.html'].toString(), big);
    assert.deepEqual(files['clip.mp4'], media);
    assert.equal(files['é.txt'].toString(), 'utf8 name');
    assert.ok(zip.length < 5000, 'text was deflated');
    const { writeZip } = await loadSaas('zipwrite.js');
    assert.throws(() => writeZip([{ name: '../evil', data: Buffer.from('x') }]), /unsafe/);
});

test('the viewer script stays a dependency-free browser IIFE that never sets cookies', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'saas', 'public', 'v.js'), 'utf8');
    assert.match(src, /^\/\*[\s\S]*?\*\/\s*\(function \(\) \{/);
    assert.doesNotMatch(src, /\bimport\b|\brequire\(|document\.cookie/);
});
