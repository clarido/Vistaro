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
        { id: 'result', time: '10s', action: 'transitionScreen', target: '#screen2', duration: 0.8, title: 'Review the result' },
    ],
};

/**
 * A reel starts from different defaults than a guide, and the difference is not guessable: no cursor,
 * a short tail, a looping in-view embed, and an `animate` reveal whose target is pre-hidden in CSS.
 */
export const REEL_SCAFFOLD = {
    meta: {
        kind: 'reel',
        title: 'Ask anything',
        slug: 'ask-anything',
        locale: 'en',
        cursor: 'none',
        tailMs: 700,
        reel: { loop: true, autoplay: 'inview' },
    },
    steps: [
        { id: 'cards', time: '0.4s', action: 'animate', target: '.card', all: true, count: 3, stagger: 0.09, from: { opacity: 0, y: 22 }, to: { opacity: 1, y: 0 }, duration: 0.6, ease: 'easeOutBack' },
        { id: 'ask', time: '1.6s', action: 'type', target: '#prompt', value: 'Where is churn risk hiding?', cps: 32 },
        { id: 'answer', time: '3.4s', action: 'animate', target: '#answer', from: { opacity: 0, y: 14 }, to: { opacity: 1, y: 0 }, duration: 0.55, ease: 'easeOutCubic' },
        { id: 'push', time: '4.4s', action: 'camera', target: '#answer', scale: 1.15, duration: 1.2, ease: 'easeInOutCubic', only: 'desktop' },
    ],
};

export function initConfigCommand(dir: string, options: { force?: boolean; kind?: string } = {}): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'anim.config.json');
    if (fs.existsSync(target) && !options.force) {
        console.error(`Error: ${target} already exists (use --force to overwrite).`);
        process.exit(1);
    }
    const reel = options.kind === 'reel';
    fs.writeFileSync(target, JSON.stringify(reel ? REEL_SCAFFOLD : CONFIG_SCAFFOLD, null, 2) + '\n');
    console.log(`Created ${target}${reel ? ' (reel profile: silent, looping, no guide)' : ''}`);
    console.log('Edit the steps to match the element selectors in your index.html, then:');
    console.log(`  npx tsx cli.ts check ${dir}     # validate selectors and timing`);
    console.log(`  npx tsx cli.ts build ${dir}     # write animated.html`);
    console.log(`  npx tsx cli.ts preview ${dir}   # one labelled frame per step`);
    if (reel) {
        console.log('');
        console.log('Reel notes, none of which the tool can infer for you:');
        // The cost is not one frame: the first keyframe lands when the step runs, so the element is
        // visible from page load until its `time`. See AGENTS.md, "Authoring a reel", constraint 2.
        console.log('  - Pre-hide anything an "animate" step reveals (opacity: 0 in CSS). The first keyframe');
        console.log('    lands when the step runs, so an un-hidden element stays visible until then: a reveal');
        console.log('    at 1s shows it for a full second before animating it in.');
        console.log('  - Declare <meta name="viewport" content="width=device-width, initial-scale=1"> in index.html.');
        console.log('  - Keep the mobile breakpoint above the widest recorded width (viewport x --scale).');
        console.log(`  npx tsx cli.ts export ${dir} -o clip.mp4 --device mobile --scale 2   # mp4 + webm + poster + gif`);
        console.log(`  npx tsx cli.ts build ${dir} --embed --device mobile                  # embed-mobile.html + snippet`);
    }
}
