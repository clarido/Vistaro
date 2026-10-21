import * as path from 'path';
import { scanProjects, ScannedProject } from './studio';

/**
 * `demos`: the terminal half of the studio's picker -- every editable project in the workspace
 * as one table (what it is, where it lives, when it was last touched, how to open it). It is
 * also the agent-facing discovery path: an agent lists demos the same way a person picks one.
 */
export function demosCommand(): void {
    const root = path.resolve(__dirname, '../..');
    const projects = scanProjects(root);
    if (!projects.length) {
        console.log('No demos found: a demo is a directory with index.html + vistaro.config.json (plus the scenario timelines beside it).');
        console.log('Start one:  npx vistaro init-config <dir>   then open it:  npx vistaro studio <dir>');
        return;
    }
    const rel = (iso: string | null): string => {
        if (!iso) return 'never';
        return iso.slice(0, 10);
    };
    const maxTitle = Math.min(38, Math.max(...projects.map(p => p.title.length)));
    const maxDir = Math.min(30, Math.max(...projects.map(p => p.dir.length + (p.configName !== 'vistaro.config.json' ? p.configName.length + 3 : 0))));
    const lines = projects.map(p => {
        const where = p.dir + (p.configName !== 'vistaro.config.json' ? ' \u00b7 ' + p.configName : '');
        const badges = [p.kind, ...(p.tour ? ['tour'] : []), ...p.locales, ...p.devices.map(d => (d === 'mobile' ? 'phone' : d))].join(',');
        return '  ' + p.title.padEnd(maxTitle) + '  ' + where.padEnd(maxDir) + '  ' + String(p.steps).padStart(2) + ' steps  ' + rel(p.lastTouched).padStart(10) + '  ' + badges;
    });
    console.log(`${projects.length} demo project(s) in ${path.basename(root)} (newest first):\n`);
    console.log('  ' + 'title'.padEnd(maxTitle) + '  ' + 'location'.padEnd(maxDir) + '  ' + '          ' + '   touched ' + '  badges');
    console.log(lines.join('\n'));
    console.log(`
Open one in the studio:`);
    for (const p of projects.slice(0, 3)) {
        console.log('  npx vistaro studio ' + p.dir + (p.configName !== 'vistaro.config.json' ? ` --config ${path.join(p.dir, 'scenarios', p.configName)}` : ''));
    }
    if (projects.length > 3) console.log(`  \u2026 and ${projects.length - 3} more (npx vistaro demos --json for the full list, or run the studio with no argument for the picker)`);
}

/** The machine-readable twin (--json): the scanner's list, verbatim. */
export function demosJson(): ScannedProject[] {
    const root = path.resolve(__dirname, '../..');
    return scanProjects(root);
}
