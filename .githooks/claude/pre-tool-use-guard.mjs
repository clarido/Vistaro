#!/usr/bin/env node
/**
 * PreToolUse guard for Bash commands — the commit/stash seatbelt and the ask-JF gate.
 *
 * MECHANISM: the harness feeds one JSON event on stdin ({tool_name, tool_input:{command}}).
 *   exit 0 = allow (silently, or with an "ask" permissionDecision JSON on stdout, which
 *            surfaces a permission prompt to JF);
 *   exit 2 = deny — stderr is fed back to the agent and the command never runs;
 *   any other non-zero = non-blocking error — stderr is printed and the command RUNS.
 *
 * Exit 2 is reachable only through an explicitly matched pattern after a successful JSON
 * parse; the entire decision sits in one try/catch and every failure mode — unreadable
 * stdin, a JSON.parse failure, missing expected fields, any unexpected exception — exits 1:
 * FAIL OPEN, loudly. A missing node degrades identically (the hook command itself fails
 * non-zero, which the harness treats as non-blocking).
 *
 * HARD DENY (fail closed):
 *   - git commit without a pathspec — it sweeps in unrelated work the agent may not own;
 *   - git stash in any form — it hides or destroys uncommitted work it may not own.
 * ASK JF (fails open BY DESIGN — on a harness that ignores permissionDecision "ask" these
 * proceed; only the two hard denies fail closed): git push (any form), git merge / git pull
 * (a pull is fetch+merge), branch creation (checkout -b/-B/--orphan, switch -c/-C, branch <name>), and
 * the overwrite family (reset --hard, clean, restore, checkout of paths).
 *
 * SEATBELT, NOT SANDBOX — stated holes, deliberately out of scope: nested shells
 * (sh -c 'git commit …', backticks, … | sh) defeat the tokenizer; a Bash-mediated file edit
 * (sed/tee) bypasses the PostToolUse typecheck; `git checkout <single-path>` without `--`
 * reads as a branch switch (git refuses rather than clobbers on conflict) and is allowed,
 * while `.` and multi-path forms are not; a lone glob that the shell cannot expand slips
 * through as one positional. This targets the agent's own typed commands, nothing smuggled.
 *
 * The guard spawns no child process — it is a pure text analysis of the command string, so
 * it needs no timeout bound of its own (AGENTS.md, «Nothing in a run may wait forever»).
 */
import { readFileSync } from 'node:fs';

const GUARD = 'pre-tool-use guard:';

const COMMIT_DENY =
    'git commit without a pathspec sweeps in unrelated work — commit only what you touched: ' +
    'git commit -m "…" -- <files>. Work that is not yours to commit stays: a red naming a ' +
    'foreign file is a cross-lot event (testing-discipline §6).';
const STASH_DENY =
    'git stash is denied — it hides or destroys uncommitted work you may not own. Set your own ' +
    'work aside with a pathspec commit, or ask JF.';

// -- verdicts ----------------------------------------------------------------
// allow → null below; deny → {kind:'deny'}; ask → {kind:'ask', what}.

const deny = (message) => ({ kind: 'deny', message });
const askJf = (what) => ({ kind: 'ask', what });

// -- tokenizer ---------------------------------------------------------------
// Quote-aware: separators (&& || ; | &, newlines) split segments only outside quotes, and
// quotes are dropped when a segment is tokenized, so `git commit -m "two words"` is one
// option plus one value, not an option plus two stray positionals. Escaped quotes inside
// quotes are not modelled — seatbelt grade, and stated as such.

function splitSegments(command) {
    const out = [];
    let cur = '';
    let quote = null;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote) {
            cur += ch;
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
        if (ch === '\n' || ch === ';' || ch === '|') {
            if (cur.trim()) out.push(cur.trim());
            cur = '';
            continue;
        }
        if (ch === '&') {
            if (cur.trim()) out.push(cur.trim());
            cur = '';
            if (command[i + 1] === '&') i++; // && is one separator
            continue;
        }
        cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

function tokenize(segment) {
    const out = [];
    let cur = '';
    let quote = null;
    for (const ch of segment) {
        if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
        cur += ch;
    }
    if (cur) out.push(cur);
    return out;
}

/** Drop env-assignment prefixes (FOO=bar PATH=…:bin git commit …), return the rest. */
function withoutEnvPrefixes(tk) {
    let i = 0;
    while (i < tk.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tk[i])) i++;
    return tk.slice(i);
}

/** After the leading `git`: consume global options (-C, -c, --git-dir, --work-tree and
 *  --namespace take a separate value; `--opt=value` forms are self-contained) and return
 *  what is left, subcommand first. */
const GLOBAL_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

function afterGlobalOptions(tk) {
    let i = 1; // tk[0] === 'git'
    while (i < tk.length && tk[i].startsWith('-')) {
        if (GLOBAL_VALUE.has(tk[i]) && i + 1 < tk.length) i += 2;
        else i += 1;
    }
    return tk.slice(i);
}

// -- git commit: a surviving positional is a pathspec -------------------------

// Value-taking commit options: the token plus its following token are one unit.
// `--opt=value` and attached short values (-mmsg, -Skey, -CHEAD) are self-contained.
const COMMIT_VALUE_LONG = new Set([
    '-m', '--message', '-F', '--file', '-c', '-C', '--reuse-message', '--reedit-message',
    '--author', '--date', '-t', '--template', '--cleanup', '--fixup', '--squash', '-S',
]);
const COMMIT_VALUE_SHORT = new Set(['m', 'F', 'c', 'C', 't', 'S']);

function commitVerdict(args) {
    const dd = args.indexOf('--');
    let pathspecs;
    if (dd !== -1) {
        pathspecs = args.slice(dd + 1); // everything after -- is a pathspec, even if dashed
    } else {
        pathspecs = [];
        for (let i = 0; i < args.length; i++) {
            const t = args[i];
            if (!t.startsWith('-')) { pathspecs.push(t); continue; }
            if (t.includes('=')) continue; // --opt=value carries its own value
            if (COMMIT_VALUE_LONG.has(t) && i + 1 < args.length) { i++; continue; }
            // -am <value>: a short bundle whose LAST letter takes the next token
            if (/^-[a-zA-Z]+$/.test(t) && COMMIT_VALUE_SHORT.has(t[t.length - 1]) && i + 1 < args.length) { i++; continue; }
            // any other dashed token is a standalone flag (-a, --amend, --no-verify, …)
        }
    }
    if (pathspecs.length > 0) return null; // a pathspec exists: the commit is scoped
    return deny(COMMIT_DENY);
}

// -- the ask-JF family --------------------------------------------------------

// checkout options whose NEXT token is a value, not a pathspec or a branch name.
const CHECKOUT_VALUE = new Set(['-B', '--orphan', '--conflict', '--pathspec-from-file']);

function checkoutVerdict(args) {
    if (args.includes('-b') || args.includes('-B') || args.includes('--orphan'))
        return askJf('git checkout -b/-B/--orphan (branch creation)');
    if (args.includes('--')) return askJf('git checkout -- <paths> (discards uncommitted changes to paths)');
    const bare = [];
    for (let i = 0; i < args.length; i++) {
        if (!args[i].startsWith('-')) { bare.push(args[i]); continue; }
        if (CHECKOUT_VALUE.has(args[i])) i++;
    }
    if (bare.includes('.')) return askJf('git checkout . (discards every uncommitted change)');
    if (bare.length >= 2) return askJf('git checkout <paths> (path-discarding form)');
    return null; // one positional reads as a branch switch: git refuses rather than clobbers
}

function switchVerdict(args) {
    if (args.includes('-c') || args.includes('-C')) return askJf('git switch -c (branch creation)');
    return null;
}

// branch options whose NEXT token is a value (a format, a sort key, an upstream), so a
// listing like `git branch --sort=committerdate` stays silent. Refnames after -d/-D/-m are
// positionals on purpose: deleting or renaming a branch is branch mutation, and it asks.
const BRANCH_VALUE = new Set([
    '--format', '--sort', '--contains', '--no-contains', '--points-at',
    '--merged', '--no-merged', '--abbrev', '--column', '-u', '--set-upstream-to',
]);

function branchVerdict(args) {
    const bare = [];
    for (let i = 0; i < args.length; i++) {
        if (!args[i].startsWith('-')) { bare.push(args[i]); continue; }
        if (BRANCH_VALUE.has(args[i])) i++;
    }
    if (bare.length > 0) return askJf('git branch <name> (branch creation or mutation)');
    return null; // bare `git branch` (or options-only) lists: allowed
}

function classifySegment(segment) {
    const tk = withoutEnvPrefixes(tokenize(segment));
    // shell grouping ((git …), {git …}) hides the leading git behind punctuation: whole tokens or a prefix
    while (tk.length > 0 && /^[({]+$/.test(tk[0])) tk.shift();
    if (tk.length > 0 && /^[({]/.test(tk[0])) tk[0] = tk[0].replace(/^[({]+/, '');
    if (tk.length === 0 || tk[0] !== 'git') return null; // anything not git allows immediately
    const rest = afterGlobalOptions(tk);
    // trailing grouping punctuation rides on the subcommand token in ((git stash))
    const sub = rest[0] === undefined ? undefined : rest[0].replace(/[)}]+$/, '');
    if (!sub) return null; // a bare `git` — nothing to check
    const args = rest.slice(1);
    switch (sub) {
        case 'commit': return commitVerdict(args);
        case 'stash': return deny(STASH_DENY); // bare, push/save/pop/drop/clear/apply/list: any form
        case 'push': return askJf('git push');
        case 'merge': return askJf('git merge');
        case 'pull': return askJf('git pull (a pull is a fetch followed by a merge)');
        case 'checkout': return checkoutVerdict(args);
        case 'switch': return switchVerdict(args);
        case 'branch': return branchVerdict(args);
        case 'reset':
            if (args.includes('--hard')) return askJf('git reset --hard (overwrites uncommitted work)');
            return null;
        case 'clean': return askJf('git clean (deletes untracked files)');
        case 'restore': return askJf('git restore (discards uncommitted changes)');
        default: return null;
    }
}

/** Worst verdict across every shell segment: a deny wins over an ask, an ask over silence. */
function decide(command) {
    let worst = null;
    for (const segment of splitSegments(command)) {
        const verdict = classifySegment(segment);
        if (!verdict) continue;
        if (verdict.kind === 'deny') return verdict;
        if (verdict.kind === 'ask') worst = verdict;
    }
    return worst;
}

// -- main: one try/catch around the whole decision; every error fails open ----

let verdict = null;
try {
    const event = JSON.parse(readFileSync(0, 'utf8'));
    if (typeof event.tool_name !== 'string') throw new Error('stdin event carries no tool_name');
    if (event.tool_name !== 'Bash') process.exit(0); // this guard's surface is Bash only
    const command = event.tool_input ? event.tool_input.command : undefined;
    if (typeof command !== 'string') throw new Error('Bash event carries no tool_input.command');
    verdict = decide(command);
} catch (err) {
    console.error(`${GUARD} ${(err && err.message) || err} — FAILING OPEN, the command was not checked`);
    process.exit(1);
}

if (verdict && verdict.kind === 'deny') {
    console.error(verdict.message);
    process.exit(2);
}
if (verdict && verdict.kind === 'ask') {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: `${verdict.what} needs JF's explicit go — typed by JF, never relayed (docs/testing-discipline.md rule 8)`,
        },
    }) + '\n');
}
process.exit(0);
