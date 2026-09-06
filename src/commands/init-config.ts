import * as fs from 'fs';
import * as path from 'path';

/** Object-form scaffold using only actions the runtime implements today. */
export const CONFIG_SCAFFOLD = {
    meta: {
        title: 'Create your first report',
        slug: 'create-first-report',
        app: 'My App',
        locale: 'en',
        cursor: 'mac',
        tailMs: 2500,
    },
    steps: [
        { id: 'intro', time: '0s', action: 'fadeIn', target: 'body', title: 'Overview', subtitle: 'Welcome to the dashboard.', narration: 'Start on the dashboard to review your reports.' },
        { id: 'open', time: '2s', action: 'click', target: '.btn-primary', title: 'Open the report builder', subtitle: 'Click the primary button to begin.', note: 'The button is in the top-right corner.' },
        { id: 'prompt', time: '3.5s', action: 'type', target: '.chat-input', value: 'Generate a report', title: 'Describe the report', subtitle: 'Enter your prompt here.', translatable: true },
        { id: 'zoom', time: '5.5s', action: 'camera', target: '.chat-input', scale: 1.3, duration: 2, guide: false },
        { id: 'notice', time: '8s', action: 'highlight', target: '#status', title: 'Watch the status', subtitle: 'The status updates when the report is ready.' },
        { id: 'result', time: '10s', action: 'transitionScreen', target: '#screen2', title: 'Review the result' },
    ],
};

export function initConfigCommand(dir: string, options: { force?: boolean } = {}): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'anim.config.json');
    if (fs.existsSync(target) && !options.force) {
        console.error(`Error: ${target} already exists (use --force to overwrite).`);
        process.exit(1);
    }
    fs.writeFileSync(target, JSON.stringify(CONFIG_SCAFFOLD, null, 2) + '\n');
    console.log(`Created ${target}`);
    console.log('Edit the steps to match the element selectors in your index.html, then:');
    console.log(`  npx tsx cli.ts check ${dir}     # validate selectors and timing`);
    console.log(`  npx tsx cli.ts build ${dir}     # write animated.html`);
    console.log(`  npx tsx cli.ts preview ${dir}   # one labelled frame per step`);
}
