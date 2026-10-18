import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloudFixture, loadSaas } from './saas-cloud-helpers';

// Unit tests for saas/lib/cloud/accounts.js over a real Store on a temp dir.

test('signup creates a user, an owned free workspace and a session that resolves back to the user', async (t) => {
    const { accounts, store } = await cloudFixture(t);
    const { user, workspace } = accounts.signup({ email: ' JF@Example.com ', password: 'hunter2hunter2', name: 'JF', workspaceName: 'Acme Corp' });
    assert.equal(user.email, 'jf@example.com');
    assert.equal(workspace.slug, 'acme-corp');
    assert.equal(workspace.plan, 'free');
    assert.equal(accounts.roleOf(workspace.id, user.id), 'owner');
    assert.ok(!JSON.stringify(store.get('users', user.id)).includes('hunter2'), 'the password is never stored in clear');
    const { token } = accounts.createSession(user.id);
    assert.equal(accounts.userForSession(token).id, user.id);
    assert.ok(!store.get('sessions', token), 'sessions are keyed by a hash, not the token');
    accounts.destroySession(token);
    assert.equal(accounts.userForSession(token), null);
});

test('signup refuses a bad email, a short password and a duplicate account', async (t) => {
    const { accounts } = await cloudFixture(t);
    assert.throws(() => accounts.signup({ email: 'nope', password: 'hunter2hunter2' }), /valid email/);
    assert.throws(() => accounts.signup({ email: 'a@b.co', password: 'short' }), /8 characters/);
    accounts.signup({ email: 'a@b.co', password: 'hunter2hunter2' });
    assert.throws(() => accounts.signup({ email: 'A@B.CO', password: 'hunter2hunter2' }), (e: { status: number }) => e.status === 409);
});

test('login checks the password and does not say which half was wrong', async (t) => {
    const { accounts } = await cloudFixture(t);
    accounts.signup({ email: 'a@b.co', password: 'hunter2hunter2' });
    assert.equal(accounts.login({ email: 'a@b.co', password: 'hunter2hunter2' }).email, 'a@b.co');
    assert.throws(() => accounts.login({ email: 'a@b.co', password: 'wrong-password' }), /wrong email or password/);
    assert.throws(() => accounts.login({ email: 'ghost@b.co', password: 'hunter2hunter2' }), /wrong email or password/);
});

test('sessions expire', async (t) => {
    const { store } = await cloudFixture(t);
    const { Accounts } = await loadSaas('cloud/accounts.js');
    let now = Date.parse('2026-10-18T00:00:00Z');
    const accounts = new Accounts(store, { now: () => now });
    const { user } = accounts.signup({ email: 'a@b.co', password: 'hunter2hunter2' });
    const { token } = accounts.createSession(user.id);
    now += 29 * 24 * 3600 * 1000;
    assert.ok(accounts.userForSession(token));
    now += 2 * 24 * 3600 * 1000;
    assert.equal(accounts.userForSession(token), null);
});

test('seats: free holds one person; an invite on a full plan is a 402 naming the upgrade', async (t) => {
    const { accounts, store } = await cloudFixture(t);
    const { workspace, user } = accounts.signup({ email: 'owner@b.co', password: 'hunter2hunter2' });
    assert.throws(() => accounts.invite(workspace, { email: 'mate@b.co' }, user.id), (e: { name: string; upgradeTo: string }) => {
        assert.equal(e.name, 'PlanError');
        assert.equal(e.upgradeTo, 'pro');
        return true;
    });
    store.update('workspaces', workspace.id, { plan: 'pro' });
    const pro = store.get('workspaces', workspace.id);
    accounts.invite(pro, { email: 'two@b.co' }, user.id);
    accounts.invite(pro, { email: 'three@b.co' }, user.id);
    assert.equal(accounts.seatsUsed(pro.id), 3, 'pending invites hold a seat');
    assert.throws(() => accounts.invite(pro, { email: 'four@b.co' }, user.id), /3 seats/);
    assert.throws(() => accounts.invite(pro, { email: 'two@b.co' }, user.id), /already invited/);
});

test('an invite is consumed at signup: the invitee joins that workspace with the invited role', async (t) => {
    const { accounts, store } = await cloudFixture(t);
    const { workspace, user } = accounts.signup({ email: 'owner@b.co', password: 'hunter2hunter2' });
    store.update('workspaces', workspace.id, { plan: 'team' });
    accounts.invite(store.get('workspaces', workspace.id), { email: 'tr@b.co', role: 'translator' }, user.id);
    const joined = accounts.signup({ email: 'tr@b.co', password: 'hunter2hunter2' });
    assert.equal(joined.workspace.id, workspace.id);
    assert.equal(accounts.roleOf(workspace.id, joined.user.id), 'translator');
    assert.equal(store.find('invites').length, 0);
    assert.equal(store.find('workspaces').length, 1, 'no second workspace was created');
});

test('the translator role is a Team feature', async (t) => {
    const { accounts, store } = await cloudFixture(t);
    const { workspace, user } = accounts.signup({ email: 'owner@b.co', password: 'hunter2hunter2' });
    store.update('workspaces', workspace.id, { plan: 'pro' });
    assert.throws(() => accounts.invite(store.get('workspaces', workspace.id), { email: 'tr@b.co', role: 'translator' }, user.id), /Team plan/);
});

test('the last owner cannot be removed', async (t) => {
    const { accounts } = await cloudFixture(t);
    const { workspace, user } = accounts.signup({ email: 'owner@b.co', password: 'hunter2hunter2' });
    assert.throws(() => accounts.removeMember(workspace, user.id, user.id), /at least one owner/);
});

test('CI tokens resolve to their workspace, record use, and stop working once revoked', async (t) => {
    const { accounts, store } = await cloudFixture(t);
    const { workspace, user } = accounts.signup({ email: 'owner@b.co', password: 'hunter2hunter2' });
    const { token, record } = accounts.createToken(workspace, 'GitHub', user.id);
    assert.match(token, /^vt_/);
    assert.equal(accounts.workspaceForToken(token).id, workspace.id);
    assert.ok(accounts.tokensOf(workspace.id)[0].lastUsedAt);
    assert.equal(accounts.workspaceForToken('vt_forged'), null);
    assert.equal(accounts.workspaceForToken('not-a-token'), null);
    assert.ok(!JSON.stringify(store.doc.tokens).includes(token), 'tokens are stored hashed');
    accounts.revokeToken(workspace, record.id, user.id);
    assert.equal(accounts.workspaceForToken(token), null);
});

test('workspace slugs are unique and never a reserved route name', async (t) => {
    const { accounts } = await cloudFixture(t);
    const a = accounts.signup({ email: 'a@b.co', password: 'hunter2hunter2', workspaceName: 'Acme' });
    const b = accounts.signup({ email: 'b@b.co', password: 'hunter2hunter2', workspaceName: 'Acme' });
    const c = accounts.signup({ email: 'c@b.co', password: 'hunter2hunter2', workspaceName: 'API' });
    assert.equal(a.workspace.slug, 'acme');
    assert.equal(b.workspace.slug, 'acme-2');
    assert.equal(c.workspace.slug, 'api-team');
});
