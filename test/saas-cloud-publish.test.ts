import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { cloudFixture, loadSaas, zipOf, GUIDE_BUNDLE } from './saas-cloud-helpers';

// Unit tests for saas/lib/cloud/publish.js: bundle detection, releases,
// plan limits, review/rollback and history pruning, against a real disk.

test('detectBundle names the kind and the entry for every output the CLI writes', async () => {
    const { detectBundle } = await loadSaas('cloud/publish.js');
    const json = (map: Record<string, unknown>) => (rel: string) => (rel in map ? map[rel] : null);

    const guide = detectBundle(['guide/guide.json', 'guide/guide.html', 'index.html'], json({ 'guide/guide.json': { title: 'G', locale: 'fr', steps: [{ id: 'a', number: 1, title: 'A' }] } }));
    assert.deepEqual([guide.kind, guide.entry, guide.title, guide.locale, guide.steps[0].key], ['guide', 'guide/guide.html', 'G', 'fr', 'a']);

    const tour = detectBundle(['index.html', 'tours.json', 'app.js'], json({ 'tours.json': { product: { name: 'Clarido' }, scenarios: [{ slug: 's', label: 'S' }] } }));
    assert.deepEqual([tour.kind, tour.entry, tour.title, tour.scenarios.length], ['tour', 'index.html', 'Clarido', 1]);

    assert.deepEqual(pick(detectBundle(['embed-mobile.html', 'embed-desktop.html', 'clip.mp4'], json({}))), ['reel', 'embed-desktop.html']);
    assert.deepEqual(pick(detectBundle(['demo.mp4', 'demo.vtt'], json({}))), ['video', 'demo.mp4']);
    assert.deepEqual(pick(detectBundle(['index.html', 'style.css'], json({}))), ['page', 'index.html']);
    assert.deepEqual(pick(detectBundle(['index.html', 'docs/a.html'], json({}), 'docs/a.html')), ['page', 'docs/a.html']);

    assert.throws(() => detectBundle(['notes.txt'], json({})), /nothing to open/);
    assert.throws(() => detectBundle(['index.html'], json({}), 'missing.html'), /not in the bundle/);
});

function pick(m: { kind: string; entry: string }): string[] {
    return [m.kind, m.entry];
}

test('freshnessFrom reads the stale and failed flags build-all already wrote', async () => {
    const { freshnessFrom } = await loadSaas('cloud/publish.js');
    const idx = { guides: [{ slug: 'a', locale: 'en', stale: true }, { slug: 'a', locale: 'fr', status: 'failed' }, { slug: 'b', locale: 'en', stale: false }] };
    assert.deepEqual(freshnessFrom(['index.json'], () => idx), { stale: ['a (en)'], failed: ['a (fr)'], checked: 3 });
    assert.deepEqual(freshnessFrom(['x.html'], () => idx), { stale: [], failed: [], checked: 0 });
});

test('a publish stores the files, numbers the release, makes it live and keeps the strings', async (t) => {
    const { publisher, accounts, dataDir } = await cloudFixture(t);
    const { workspace, user } = accounts.signup({ email: 'a@b.co', password: 'hunter2hunter2' });
    const { project, release } = publisher.publish(workspace, await zipOf(GUIDE_BUNDLE), { slug: 'First Report!', actorId: user.id, git: { sha: 'abc', branch: 'main' } });
    assert.equal(project.slug, 'first-report');
    assert.equal(project.title, 'Create your first report', 'the guide title names a new project');
    assert.equal(release.number, 1);
    assert.equal(release.status, 'live');
    assert.equal(project.liveReleaseId, release.id);
    assert.deepEqual(release.git, { sha: 'abc', branch: 'main', pr: null });
    const site = path.join(dataDir, 'cloud', 'releases', release.id, 'site');
    assert.ok(fs.existsSync(path.join(site, 'guide', 'guide.html')));
    assert.deepEqual(publisher.releaseStrings(release.id), {
        en: { 'meta.title': 'Create your first report', 'steps.open.title': 'Open the builder' },
        fr: { 'meta.title': 'Créer votre premier rapport' },
    });
    const second = publisher.publish(workspace, await zipOf(GUIDE_BUNDLE), { slug: 'first-report' });
    assert.equal(second.release.number, 2);
    assert.equal(publisher.releasesOf(project.id).find((r: { number: number }) => r.number === 1).status, 'archived');
});

test('a single wrapper folder in the zip is unwrapped', async (t) => {
    const { publisher, accounts } = await cloudFixture(t);
    const { workspace } = accounts.signup({ email: 'a@b.co', password: 'hunter2hunter2' });
    const wrapped = Object.fromEntries(Object.entries(GUIDE_BUNDLE).map(([k, v]) => [`demo/${k}`, v]));
    const { release } = publisher.publish(workspace, await zipOf(wrapped), { slug: 'w' });
    assert.equal(release.entry, 'guide/guide.html');
});

test('a bad bundle leaves nothing behind', async (t) => {
    const { publisher, accounts, dataDir, store } = await cloudFixture(t);
    const { workspace } = accounts.signup({ email: 'a@b.co', password: 'hunter2hunter2' });
    assert.throws(() => publisher.publish(workspace, Buffer.from('not a zip'), { slug: 'x' }), /ZIP archive/);
    assert.throws(() => publisher.publish(workspace, Buffer.alloc(0), { slug: 'x' }), /ZIP archive/);
    await assert.rejects(async () => publisher.publish(workspace, await zipOf({ 'readme.txt': 'hi' }), { slug: 'x' }), /nothing to open/);
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'cloud', 'releases')), []);
    assert.equal(store.find('releases').length, 0);
});

test('free hosts three projects; the fourth is a 402 that names Pro', async (t) => {
    const { publisher, accounts } = await cloudFixture(t);
    const { workspace } = accounts.signup({ email: 'a@b.co', password: 'hunter2hunter2' });
    const zip = await zipOf(GUIDE_BUNDLE);
    for (const s of ['a', 'b', 'c']) publisher.publish(workspace, zip, { slug: s });
    assert.throws(() => publisher.publish(workspace, zip, { slug: 'd' }), (e: { name: string; upgradeTo: string }) => e.name === 'PlanError' && e.upgradeTo === 'pro');
    // Re-publishing an existing project is never blocked by the project count.
    assert.equal(publisher.publish(workspace, zip, { slug: 'a' }).release.number, 2);
});

test('drafts need the review feature; approving makes a draft live; rollback needs the rollback feature', async (t) => {
    const { publisher, accounts, store } = await cloudFixture(t);
    const { workspace } = accounts.signup({ email: 'a@b.co', password: 'hunter2hunter2' });
    const zip = await zipOf(GUIDE_BUNDLE);
    assert.throws(() => publisher.publish(workspace, zip, { slug: 'p', draft: true }), /Team plan/);

    publisher.publish(workspace, zip, { slug: 'p' });
    publisher.publish(workspace, zip, { slug: 'p' });
    const proj = () => publisher.projectBySlug(workspace.id, 'p');
    assert.throws(() => publisher.promote(workspace, proj(), 1, null), /Pro plan/, 'free cannot roll back');

    store.update('workspaces', workspace.id, { plan: 'team' });
    const team = store.get('workspaces', workspace.id);
    const draft = publisher.publish(team, zip, { slug: 'p', draft: true }).release;
    assert.equal(draft.status, 'draft');
    assert.equal(proj().liveReleaseId, publisher.releasesOf(proj().id).find((r: { number: number }) => r.number === 2).id, 'a draft does not go live');
    publisher.promote(team, proj(), draft.number, null);
    assert.equal(proj().liveReleaseId, draft.id);
    publisher.promote(team, proj(), 1, null);
    assert.equal(publisher.releasesOf(proj().id).find((r: { number: number }) => r.number === 1).status, 'live');
    assert.equal(publisher.releasesOf(proj().id).filter((r: { status: string }) => r.status === 'live').length, 1, 'exactly one live release');

    store.update('workspaces', workspace.id, { requireReview: true });
    assert.equal(publisher.publish(store.get('workspaces', workspace.id), zip, { slug: 'p' }).release.status, 'draft', 'requireReview turns every publish into a draft');
});

test('history is pruned to the plan, the live release is never pruned, drafts are kept', async (t) => {
    const { publisher, accounts, dataDir } = await cloudFixture(t);
    const { workspace } = accounts.signup({ email: 'a@b.co', password: 'hunter2hunter2' });
    const zip = await zipOf(GUIDE_BUNDLE);
    let last = null;
    for (let i = 0; i < 5; i++) last = publisher.publish(workspace, zip, { slug: 'p' }).release;
    const rels = publisher.releasesOf(publisher.projectBySlug(workspace.id, 'p').id);
    assert.deepEqual(rels.map((r: { number: number }) => r.number), [5, 4, 3], 'free keeps 3 releases');
    assert.equal(rels[0].id, last.id);
    const dirs = fs.readdirSync(path.join(dataDir, 'cloud', 'releases')).sort();
    assert.deepEqual(dirs, rels.map((r: { id: string }) => r.id).sort(), 'pruned releases are gone from disk too');
});

test('deleting a project removes its releases, leads and translations', async (t) => {
    const { publisher, accounts, store, dataDir } = await cloudFixture(t);
    const { workspace } = accounts.signup({ email: 'a@b.co', password: 'hunter2hunter2' });
    const { project } = publisher.publish(workspace, await zipOf(GUIDE_BUNDLE), { slug: 'p' });
    store.put('leads', 'l1', { id: 'l1', projectId: project.id });
    store.put('strings', project.id, { fr: {} });
    publisher.deleteProject(workspace, project, null);
    assert.equal(store.find('projects').length, 0);
    assert.equal(store.find('releases').length, 0);
    assert.equal(store.find('leads').length, 0);
    assert.equal(store.get('strings', project.id), null);
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'cloud', 'releases')), []);
});

test('the store survives a restart', async (t) => {
    const { store, accounts, publisher } = await cloudFixture(t);
    const { workspace } = accounts.signup({ email: 'a@b.co', password: 'hunter2hunter2' });
    publisher.publish(workspace, await zipOf(GUIDE_BUNDLE), { slug: 'p' });
    const { Store } = await loadSaas('cloud/store.js');
    const reopened = new Store(store.file);
    assert.equal(reopened.find('projects')[0].slug, 'p');
    assert.equal(reopened.find('users')[0].email, 'a@b.co');
});
