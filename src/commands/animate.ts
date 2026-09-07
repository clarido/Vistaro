import * as fs from 'fs';
import * as path from 'path';
import { generateContent, ProviderConfig, resolveProvider } from '../providers';
import { recordEvent } from '../manifest';
import { loadTimeline, validateTimeline, formatIssue, parseTimeline } from '../engine/schema';
import { buildAnimatedHtml } from '../engine/inject';

const SYSTEM_PROMPT = `You are an expert CSS / UI Animator. You will be provided with the HTML source code of a UI component, and a prompt describing how it should be animated.

RULES:
1. Output ONLY valid HTML code, which is the original HTML modified to include your animations. Do NOT wrap it in markdown block quotes (e.g. \`\`\`html).
2. Add your CSS animations directly into the existing <style> block, or add a new <style> block.
3. Use precise CSS @keyframes, transitions, or minimal inline JavaScript if absolutely necessary (CSS is preferred).
4. Modify the elements' inline styles or add classes to apply the animations. Make sure the initial state matches the first frame of the animation.
5. The animations should be high-quality, smooth, and dynamic. Consider timing, easing, and delays nicely.
6. Do NOT change the layout or structure unnecessarily, just inject the animation styling.`;

export async function animateCommand(outputDir: string, prompt: string, options: { provider: string, model?: string, cursor: string, loop?: boolean, locale?: string }) {
    console.log(`Starting animation using provider: ${options.provider}. Cursor: ${options.cursor}`);
    const htmlPath = path.resolve(outputDir, 'index.html');

    if (!fs.existsSync(htmlPath)) {
        console.error(`Error: Base HTML not found at ${htmlPath}. Did you run 'extract' first?`);
        process.exit(1);
    }

    try {
        const baseHtml = fs.readFileSync(htmlPath, 'utf-8');
        console.log('Generating animation CSS/JS... (this may take a minute)');
        const resolved = resolveProvider(options.provider);
        const config: ProviderConfig = { provider: resolved, model: options.model };

        let cursorInstruction = '';
        if (options.cursor !== 'none') {
             cursorInstruction = `\n\nCRITICAL: A fake cursor <div id="anim-cli-cursor"></div> will be magically injected into the HTML. YOU MUST output CSS @keyframes to animate #anim-cli-cursor to simulate the user mouse movements based on the prompt!`;
        }
        let configInstruction = '';
        const configPath = path.resolve(outputDir, 'anim.config.json');
        if (fs.existsSync(configPath)) {
            const configJson = fs.readFileSync(configPath, 'utf8');
            configInstruction = `\n\nCRITICAL TIMELINE CONFIG: The user has provided a strict declarative JSON timeline for the animations. You MUST translate this exactly into CSS @keyframes and animation delays so the timing matches the timeline precisely!\nTimeline definition:\n${configJson}\n`;
        }

        const userPrompt = `Base HTML:\n${baseHtml}\n\nAnimation Request: ${prompt}${cursorInstruction}${configInstruction}`;

        let animatedHtml = await generateContent(
            config,
            SYSTEM_PROMPT,
            userPrompt
        );

        // Clean up markdown formatting
        animatedHtml = animatedHtml.trim();
        if (animatedHtml.startsWith('```html')) {
            animatedHtml = animatedHtml.replace(/^```html\n/, '').replace(/\n```$/, '');
        } else if (animatedHtml.startsWith('```')) {
            animatedHtml = animatedHtml.replace(/^```\n/, '').replace(/\n```$/, '');
        }

        // Inject the shared interaction runtime (cursor, ripples, spotlight highlight, camera,
        // scroll, subtitles) driven by anim.config.json -- the same engine `build` uses.
        if (fs.existsSync(configPath)) {
            try {
                const timeline = loadTimeline(outputDir, { locale: options.locale });
                for (const issue of validateTimeline(timeline)) console.error(formatIssue(issue));
                animatedHtml = buildAnimatedHtml(animatedHtml, timeline, { cursor: options.cursor, loop: options.loop });
            } catch (e: any) { console.error('Error parsing timeline config', e.message); }
        } else if (options.cursor !== 'none') {
            // No timeline: still provide #anim-cli-cursor so the LLM's keyframes have something to animate.
            animatedHtml = buildAnimatedHtml(animatedHtml, parseTimeline([]), { cursor: options.cursor, loop: options.loop });
        }

        const outPath = path.join(outputDir, 'animated.html');
        fs.writeFileSync(outPath, animatedHtml, 'utf-8');
        recordEvent(outputDir, { command: 'animate', prompt, provider: options.provider, model: options.model, cursor: options.cursor, loop: options.loop, locale: options.locale });
        console.log(`\nSuccess! Animated HTML saved to ${outPath}`);
    } catch (error: any) {
        console.error('Failed to animate UI:', error.message);
        process.exit(1);
    }
}
