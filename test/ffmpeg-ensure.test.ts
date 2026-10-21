import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureFfmpeg } from '../src/media/ffmpeg';

// npm 12 and pnpm block dependency install scripts, so ffmpeg-static's download never runs and
// export used to record a whole video and then die on `spawnSync ... ENOENT`. ensureFfmpeg runs
// ffmpeg-static's own installer instead, before anything is recorded. These stand-ins replace the
// binary and the installer so the test never touches the network or the real binary.
let dir: string;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vistaro-ffmpeg-')); });
after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

function installer(name: string, body: string): string {
    const file = path.join(dir, `${name}.js`);
    fs.writeFileSync(file, body);
    return file;
}

test('a present binary is returned as is, and the installer is not run', () => {
    const bin = path.join(dir, 'present-ffmpeg');
    fs.writeFileSync(bin, '');
    const marker = path.join(dir, 'installer-ran');
    const inst = installer('marker', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`);
    assert.equal(ensureFfmpeg({ bin, installer: inst }), bin);
    assert.equal(fs.existsSync(marker), false, 'no download when the binary is already there');
});

test('a missing binary is fetched by the installer before it is returned', () => {
    const bin = path.join(dir, 'fetched-ffmpeg');
    const inst = installer('fetches', `require('fs').writeFileSync(${JSON.stringify(bin)}, '')`);
    assert.equal(ensureFfmpeg({ bin, installer: inst }), bin);
    assert.ok(fs.existsSync(bin), 'the installer put the binary in place');
});

test('when the installer cannot fetch it, the error names the one command that does', () => {
    const bin = path.join(dir, 'never-ffmpeg');
    const inst = installer('fails', 'process.exit(3)');
    assert.throws(() => ensureFfmpeg({ bin, installer: inst }), (e: Error) => {
        assert.match(e.message, /ffmpeg is missing/);
        assert.ok(e.message.includes(`node ${inst}`), `the message names the installer to run: ${e.message}`);
        return true;
    });
});
