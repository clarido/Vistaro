import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pickWorkspaceRoot } from '../src/commands/studio';

/**
 * The studio's workspace root (issue: the installed CLI's bare boot): in the repo the package
 * directory IS the workspace, so `path.resolve(__dirname, '../..')` found every screen — but a
 * globally installed `vistaro` ships no screens in its package, so its bare boot indexed the
 * install dir, found nothing, and /api/open resolved "relative to this workspace" inside the
 * global package. The rule: the package dir when a scan of it finds at least one screen, else
 * the caller's working directory (what the overlay's hint promises). Pure function, so this
 * file spawns nothing: both roots are tmp trees.
 */

const MINIMAL_CONFIG = JSON.stringify({ meta: { title: 'Screen', slug: 'screen' }, steps: [] });

function tmpTree(name: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `studio-root-${name}-`));
}

function writeScreen(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body><main id="app">screen</main></body></html>');
    fs.writeFileSync(path.join(dir, 'anim.config.json'), MINIMAL_CONFIG);
}

test('pickWorkspaceRoot: a package dir that scans to at least one screen is the root, even when the cwd differs', () => {
    const packageDir = tmpTree('package');
    const cwd = tmpTree('cwd');
    try {
        // A screen nested the way demos live (not at the package root), found by the walk.
        writeScreen(path.join(packageDir, 'demo', 'create-first-report'));
        assert.equal(pickWorkspaceRoot(packageDir, cwd), packageDir, 'the package dir carries a screen, so it stays the workspace root');
    } finally {
        fs.rmSync(packageDir, { recursive: true, force: true });
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});

test('pickWorkspaceRoot: an installed-looking package dir (no screens anywhere under it) falls back to the cwd', () => {
    const packageDir = tmpTree('installed');
    const cwd = tmpTree('cwd');
    try {
        // Dirs and files an installed package really has -- none of it is a screen (the pair
        // rule wants index.html + anim.config.json in the same directory).
        fs.mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
        fs.mkdirSync(path.join(packageDir, 'src', 'commands'), { recursive: true });
        fs.writeFileSync(path.join(packageDir, 'package.json'), '{"name":"vistaro"}');
        fs.writeFileSync(path.join(packageDir, 'src', 'commands', 'studio.js'), 'export {}; // no index.html beside it');
        assert.equal(pickWorkspaceRoot(packageDir, cwd), cwd, 'no screen under the package dir, so the cwd is the workspace root');
    } finally {
        fs.rmSync(packageDir, { recursive: true, force: true });
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});

// Boundary smoke, not a discriminating test: with identical arguments both branches return the
// same string, so it only catches an implementation leaving the directory entirely. The two
// tests above carry the real discrimination.
test('pickWorkspaceRoot: cwd === packageDir returns that directory either way', () => {
    const withScreen = tmpTree('same-screen');
    const withoutScreen = tmpTree('same-empty');
    try {
        writeScreen(path.join(withScreen, 'demo'));
        assert.equal(pickWorkspaceRoot(withScreen, withScreen), withScreen, 'identical roots with a screen: the package dir wins and equals the cwd');
        assert.equal(pickWorkspaceRoot(withoutScreen, withoutScreen), withoutScreen, 'identical roots without a screen: the cwd fallback equals the package dir');
    } finally {
        fs.rmSync(withScreen, { recursive: true, force: true });
        fs.rmSync(withoutScreen, { recursive: true, force: true });
    }
});
