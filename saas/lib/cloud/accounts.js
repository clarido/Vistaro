'use strict';
/**
 * Users, sessions, workspaces, members, invites, CI tokens and the audit log.
 *
 * Identity model: a user belongs to one or more workspaces; the workspace is
 * the billing unit (plan, seats, domain). Roles:
 *   owner       everything, billing included
 *   admin       everything but billing and deleting the workspace
 *   editor      publish, configure projects, read analytics and leads
 *   translator  read projects, edit translations only (Team)
 *
 * Secrets are never stored: sessions and CI tokens are kept as SHA-256 of the
 * random value, passwords as scrypt.
 */

const { id, secret, sha256hex, hashPassword, verifyPassword, slugify, SLUG_RE, normalizeEmail } = require('./util');
const { planOf, requireFeature, PlanError } = require('./plans');

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const ROLES = ['owner', 'admin', 'editor', 'translator'];
const ROLE_RANK = { translator: 1, editor: 2, admin: 3, owner: 4 };
const RESERVED_SLUGS = new Set(['api', 'app', 'www', 'admin', 'help', 'docs', 'static', 'vistaro', 'ops', 'p', 'h', 'r']);

class AccountError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AccountError';
    this.status = status;
  }
}

class Accounts {
  /** @param {import('./store').Store} store */
  constructor(store, { now = () => Date.now() } = {}) {
    this.store = store;
    this.now = now;
  }

  // ---- users & sessions --------------------------------------------------

  signup({ email, password, name, workspaceName }) {
    const e = normalizeEmail(email);
    if (!e) throw new AccountError(400, 'a valid email is required');
    if (typeof password !== 'string' || password.length < 8) throw new AccountError(400, 'the password needs at least 8 characters');
    if (this.store.findOne('users', (u) => u.email === e)) throw new AccountError(409, 'an account with this email already exists');
    const user = {
      id: id('usr'), email: e, name: String(name || e.split('@')[0]).slice(0, 80),
      pwHash: hashPassword(password), createdAt: new Date(this.now()).toISOString(),
    };
    this.store.put('users', user.id, user);
    // A pending invite for this email joins that workspace instead of creating one.
    const invite = this.store.findOne('invites', (i) => i.email === e);
    let workspace;
    if (invite) {
      workspace = this.store.get('workspaces', invite.workspaceId);
      this.addMember(workspace, user.id, invite.role);
      this.store.remove('invites', invite.token);
    } else {
      workspace = this.createWorkspace({ name: workspaceName || `${user.name}'s workspace`, ownerId: user.id });
    }
    this.audit(workspace.id, user.id, 'user.signup', { email: e });
    return { user, workspace };
  }

  login({ email, password }) {
    const e = normalizeEmail(email);
    const user = e && this.store.findOne('users', (u) => u.email === e);
    // Verify against a dummy hash when the user is unknown so timing does not reveal accounts.
    const ok = verifyPassword(password, user ? user.pwHash : DUMMY_HASH);
    if (!user || !ok) throw new AccountError(401, 'wrong email or password');
    return user;
  }

  createSession(userId) {
    const token = secret('vs_');
    const now = this.now();
    this.store.put('sessions', sha256hex(token), { userId, createdAt: now, expiresAt: now + SESSION_TTL_MS });
    return { token, maxAgeSec: SESSION_TTL_MS / 1000 };
  }

  userForSession(token) {
    if (!token) return null;
    const key = sha256hex(token);
    const s = this.store.get('sessions', key);
    if (!s) return null;
    if (s.expiresAt <= this.now()) { this.store.remove('sessions', key); return null; }
    return this.store.get('users', s.userId);
  }

  destroySession(token) {
    if (token) this.store.remove('sessions', sha256hex(token));
  }

  // ---- workspaces & members ---------------------------------------------

  createWorkspace({ name, ownerId }) {
    let base = slugify(name) || 'workspace';
    if (RESERVED_SLUGS.has(base)) base = `${base}-team`;
    let slug = base;
    for (let n = 2; this.store.findOne('workspaces', (w) => w.slug === slug); n += 1) slug = `${base}-${n}`.slice(0, 48);
    const ws = {
      id: id('ws'), slug, name: String(name).slice(0, 80), plan: 'free',
      billing: null, customDomain: null, webhookUrl: null, requireReview: false,
      brand: { accent: '#E4632B', logoText: String(name).slice(0, 40) },
      createdAt: new Date(this.now()).toISOString(),
    };
    this.store.put('workspaces', ws.id, ws);
    this.addMember(ws, ownerId, 'owner', { bypassSeats: true });
    return ws;
  }

  membersOf(workspaceId) {
    return this.store.find('members', (m) => m.workspaceId === workspaceId);
  }

  workspacesOf(userId) {
    return this.store.find('members', (m) => m.userId === userId)
      .map((m) => ({ workspace: this.store.get('workspaces', m.workspaceId), role: m.role }))
      .filter((x) => x.workspace);
  }

  roleOf(workspaceId, userId) {
    const m = this.store.get('members', `${workspaceId}:${userId}`);
    return m ? m.role : null;
  }

  /** Seats count members AND pending invites, so an invite cannot overbook a plan. */
  seatsUsed(workspaceId) {
    return this.membersOf(workspaceId).length + this.store.find('invites', (i) => i.workspaceId === workspaceId).length;
  }

  addMember(workspace, userId, role, { bypassSeats = false } = {}) {
    if (!ROLES.includes(role)) throw new AccountError(400, `unknown role ${role}`);
    const key = `${workspace.id}:${userId}`;
    if (!this.store.get('members', key) && !bypassSeats) this.assertSeat(workspace, role, { joining: true });
    return this.store.put('members', key, { workspaceId: workspace.id, userId, role });
  }

  assertSeat(workspace, role, { joining = false } = {}) {
    if (role === 'translator') requireFeature(workspace, 'translations');
    const plan = planOf(workspace);
    // A signup consuming its own invite is already counted in seatsUsed.
    const used = this.seatsUsed(workspace.id) - (joining ? 1 : 0);
    if (used >= plan.seats) {
      throw new PlanError(`the ${plan.name} plan includes ${plan.seats} seat${plan.seats === 1 ? '' : 's'}`, {
        feature: 'seats', upgradeTo: plan.id === 'free' ? 'pro' : plan.id === 'pro' ? 'team' : 'enterprise',
      });
    }
  }

  invite(workspace, { email, role = 'editor' }, actorId) {
    const e = normalizeEmail(email);
    if (!e) throw new AccountError(400, 'a valid email is required');
    if (!ROLES.includes(role) || role === 'owner') throw new AccountError(400, 'role must be admin, editor or translator');
    const existing = this.store.findOne('users', (u) => u.email === e);
    if (existing && this.roleOf(workspace.id, existing.id)) throw new AccountError(409, 'already a member');
    if (this.store.findOne('invites', (i) => i.workspaceId === workspace.id && i.email === e)) throw new AccountError(409, 'already invited');
    this.assertSeat(workspace, role);
    if (existing) {
      this.addMember(workspace, existing.id, role, { bypassSeats: true });
      this.audit(workspace.id, actorId, 'member.add', { email: e, role });
      return { added: true };
    }
    const token = secret('inv_', 12);
    this.store.put('invites', token, { token, workspaceId: workspace.id, email: e, role, createdAt: new Date(this.now()).toISOString() });
    this.audit(workspace.id, actorId, 'member.invite', { email: e, role });
    return { invited: true, token };
  }

  removeMember(workspace, userId, actorId) {
    const role = this.roleOf(workspace.id, userId);
    if (!role) throw new AccountError(404, 'not a member');
    if (role === 'owner' && this.membersOf(workspace.id).filter((m) => m.role === 'owner').length === 1) {
      throw new AccountError(400, 'a workspace keeps at least one owner');
    }
    this.store.remove('members', `${workspace.id}:${userId}`);
    this.audit(workspace.id, actorId, 'member.remove', { userId });
  }

  // ---- CI tokens --------------------------------------------------------

  createToken(workspace, name, actorId) {
    const token = secret('vt_');
    const rec = {
      id: id('tok'), workspaceId: workspace.id, name: String(name || 'CI').slice(0, 60),
      prefix: token.slice(0, 7), createdAt: new Date(this.now()).toISOString(), lastUsedAt: null, createdBy: actorId,
    };
    this.store.put('tokens', sha256hex(token), rec);
    this.audit(workspace.id, actorId, 'token.create', { name: rec.name });
    return { token, record: rec };
  }

  workspaceForToken(token) {
    if (typeof token !== 'string' || !token.startsWith('vt_')) return null;
    const key = sha256hex(token);
    const rec = this.store.get('tokens', key);
    if (!rec) return null;
    this.store.update('tokens', key, { lastUsedAt: new Date(this.now()).toISOString() });
    return this.store.get('workspaces', rec.workspaceId);
  }

  tokensOf(workspaceId) {
    return this.store.find('tokens', (t) => t.workspaceId === workspaceId);
  }

  revokeToken(workspace, tokenId, actorId) {
    const n = this.store.removeWhere('tokens', (t) => t.workspaceId === workspace.id && t.id === tokenId);
    if (!n) throw new AccountError(404, 'no such token');
    this.audit(workspace.id, actorId, 'token.revoke', { tokenId });
  }

  // ---- audit ------------------------------------------------------------

  audit(workspaceId, actorId, action, detail = {}) {
    const rec = { id: id('aud'), workspaceId, actorId: actorId || null, action, detail, at: new Date(this.now()).toISOString() };
    this.store.put('audit', rec.id, rec);
    return rec;
  }

  auditOf(workspaceId, limit = 200) {
    return this.store.find('audit', (a) => a.workspaceId === workspaceId).slice(-limit).reverse();
  }
}

function atLeast(role, min) {
  return (ROLE_RANK[role] || 0) >= ROLE_RANK[min];
}

const DUMMY_HASH = hashPassword('not-a-real-password');

module.exports = { Accounts, AccountError, ROLES, atLeast, SLUG_RE, RESERVED_SLUGS, SESSION_TTL_MS };
