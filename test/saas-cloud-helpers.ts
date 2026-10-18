import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Shared loaders for the Vistaro Cloud unit tests (saas/lib/cloud/*.js).
//
// The modules are plain CommonJS JavaScript with no declaration files, so a
// static import would fail `tsc --noEmit` with TS7016. As in saas-jobs.test.ts,
// a NON-LITERAL dynamic import keeps TypeScript silent; the tests then treat
// the exports as `any` and assert on behaviour, not on types.

export type Mod = any;

export async function loadSaas(rel: string): Promise<Mod> {
    const specifier = `../saas/lib/${rel}`;
    const mod = (await import(specifier)) as { default?: Mod } & Mod;
    return mod.default ?? mod;
}

export function tempDir(t: { after: (fn: () => void) => void }, prefix = 'vistaro-cloud-'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/** A fresh store + accounts + publisher over a temp data dir. */
export async function cloudFixture(t: { after: (fn: () => void) => void }): Promise<{ dataDir: string; store: Mod; accounts: Mod; publisher: Mod; plans: Mod }> {
    const dataDir = tempDir(t);
    const { Store } = await loadSaas('cloud/store.js');
    const { Accounts } = await loadSaas('cloud/accounts.js');
    const { Publisher } = await loadSaas('cloud/publish.js');
    const plans = await loadSaas('cloud/plans.js');
    const store = new Store(path.join(dataDir, 'cloud', 'cloud.json'));
    const accounts = new Accounts(store);
    const publisher = new Publisher(store, accounts, { dataDir });
    return { dataDir, store, accounts, publisher, plans };
}

/** Zip a {name: content} map with the Cloud's own writer. */
export async function zipOf(files: Record<string, string | Buffer>): Promise<Buffer> {
    const { writeZip } = await loadSaas('zipwrite.js');
    return writeZip(Object.entries(files).map(([name, data]) => ({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') })));
}

export const GUIDE_BUNDLE: Record<string, string> = {
    'guide/guide.json': JSON.stringify({
        version: 1, slug: 'first', title: 'Create your first report', locale: 'en', generatedAt: '2026-10-18T00:00:00Z',
        steps: [{ index: 1, number: 1, id: 'open', title: 'Open the builder' }, { index: 2, number: 2, id: 'type', title: 'Describe it' }],
    }),
    'guide/guide.html': '<!doctype html><html><body><section class="step" id="open"><h2>Open the builder</h2></section></body></html>',
    'guide/assets/step-01.png': 'not really a png',
    'strings.en.json': JSON.stringify({ 'meta.title': 'Create your first report', 'steps.open.title': 'Open the builder' }),
    'locales/fr/strings.fr.json': JSON.stringify({ 'meta.title': 'Créer votre premier rapport' }),
};
