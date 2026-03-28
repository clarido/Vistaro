import * as fs from 'fs';
import * as path from 'path';
import { generateContent, ProviderConfig, resolveProvider } from '../providers';

const SYSTEM_PROMPT = `You are an expert CSS / UI Animator. You will be provided with the HTML source code of a UI component, and a prompt describing how it should be animated.

RULES:
1. Output ONLY valid HTML code, which is the original HTML modified to include your animations. Do NOT wrap it in markdown block quotes (e.g. \`\`\`html).
2. Add your CSS animations directly into the existing <style> block, or add a new <style> block.
3. Use precise CSS @keyframes, transitions, or minimal inline JavaScript if absolutely necessary (CSS is preferred).
4. Modify the elements' inline styles or add classes to apply the animations. Make sure the initial state matches the first frame of the animation.
5. The animations should be high-quality, smooth, and dynamic. Consider timing, easing, and delays nicely.
6. Do NOT change the layout or structure unnecessarily, just inject the animation styling.`;

export async function animateCommand(outputDir: string, prompt: string, options: { provider: string, model?: string, cursor: string, loop?: boolean }) {
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

        if (options.cursor !== 'none') {
            // Inject cursor DOM and CSS natively (top left origin for JS JS-engine coordinate base)
            const cursorCss = options.cursor === 'mac' 
                ? `\n<style>\n#anim-cli-cursor { position: fixed; top: 0; left: 0; transform: translate(50vw, 120vh); width: 28px; height: 28px; z-index: 99999; pointer-events: none; background: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%230F172A" stroke="white" stroke-width="1.5"><path d="M4 2v20l5.83-5.83 3.96 8.5 3.65-1.7-3.96-8.5H22L4 2z"/></svg>') no-repeat; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3)); transform-origin: top left; transition: transform 0.8s cubic-bezier(0.25, 1, 0.5, 1); }\n</style>\n`
                : `\n<style>\n#anim-cli-cursor { position: fixed; top: 0; left: 0; transform: translate(50vw, 120vh); width: 20px; height: 20px; z-index: 99999; pointer-events: none; background: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white" stroke="black" stroke-width="1"><path d="M2 2l20 10-8 2-2 8z"/></svg>') no-repeat; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3)); transform-origin: top left; transition: transform 0.8s cubic-bezier(0.25, 1, 0.5, 1); }\n</style>\n`;
            
            animatedHtml = animatedHtml.replace('</body>', `    <div id="anim-cli-cursor"></div>\n</body>`);
            animatedHtml = animatedHtml.replace('</head>', `${cursorCss}</head>`);
        }

        // INJECT SUBTITLES DYNAMICALLY IF FOUND IN CONFIG
        const configPathLoc = path.resolve(outputDir, 'anim.config.json');
        if (fs.existsSync(configPathLoc)) {
            try {
                const cfg = JSON.parse(fs.readFileSync(configPathLoc, 'utf8'));
                let subsHtml = '';
                let subsCss = '';
                cfg.forEach((step: any, index: number) => {
                    if (step.subtitle) {
                        const tFloat = parseFloat(step.time.replace('s', ''));
                        let nextT = tFloat + 4;
                        // Find next subtitle time to calculate duration
                        for(let i = index+1; i < cfg.length; i++) {
                             if (cfg[i].subtitle) {
                                 nextT = parseFloat(cfg[i].time.replace('s', ''));
                                 break;
                             }
                        }
                        const duration = Math.max(1, nextT - tFloat);
                        subsHtml += `\n<div class="anim-cli-sub-item anim-sub-${index}">${step.subtitle}</div>`;
                        subsCss += `\n.anim-sub-${index} { opacity: 0; animation: anim-cli-subFade ${duration}s ease ${tFloat}s forwards; }`;
                    }
                });
                
                if (subsHtml !== '') {
                    const masterCss = `\n<style>\n#anim-cli-subtitle-layer { position: fixed; bottom: 40px; left: 0; right: 0; display: flex; justify-content: center; z-index: 99998; pointer-events: none; padding: 0 40px; }\n.anim-cli-sub-item { position: absolute; bottom: 0; background: rgba(0,0,0,0.85); color: white; padding: 14px 28px; border-radius: 12px; font-family: -apple-system, sans-serif; font-size: 20px; line-height: 1.4; text-align: center; max-width: 800px; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.5); opacity: 0; font-weight: 500; letter-spacing: 0.3px; backdrop-filter: blur(8px); border: 1px solid rgba(255,255,255,0.1); }\n@keyframes anim-cli-subFade { 0% { opacity: 0; transform: translateY(10px); } 10%, 90% { opacity: 1; transform: translateY(0); } 100% { opacity: 0; transform: translateY(-10px); } }${subsCss}\n</style>\n`;
                    animatedHtml = animatedHtml.replace('</body>', `    <div id="anim-cli-subtitle-layer">${subsHtml}</div>\n</body>`);
                    animatedHtml = animatedHtml.replace('</head>', `${masterCss}</head>`);
                }

                // INJECT V3 CURSOR TRACKING ENGINE 
                if (options.cursor !== 'none') {
                    const engineScript = `\n<script>\ndocument.addEventListener('DOMContentLoaded', () => {\n  const timeline = ${JSON.stringify(cfg)};\n  const cursor = document.getElementById('anim-cli-cursor');\n  if (!cursor) return;\n  timeline.forEach((step, index) => {\n    if (!step.target || step.target === 'body') return;\n    const ms = parseFloat(step.time.replace('s','')) * 1000;\n    setTimeout(() => {\n      const el = document.querySelector(step.target);\n      if (el) {
        const rect = el.getBoundingClientRect();
        let tx = rect.left + rect.width / 2;
        let ty = rect.top + rect.height / 2;
        if (step.xOffset) tx += parseFloat(step.xOffset);
        if (step.yOffset) ty += parseFloat(step.yOffset);
        const transitionSpeed = index === 0 ? '1.4s' : '0.8s';
        cursor.style.transition = 'all ' + transitionSpeed + ' cubic-bezier(0.25, 1, 0.5, 1)';
        cursor.style.transform = 'translate(' + tx + 'px, ' + ty + 'px)';\n        setTimeout(() => {\n          cursor.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(0.85)';\n          setTimeout(() => {\n            cursor.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(1)';\n            if (step.action === 'focus' || step.action === 'click') {\n               document.querySelectorAll('.input, button').forEach(n => { n.style.borderColor = '#E2E8F0'; n.style.boxShadow = 'none'; n.style.background = (n.tagName==='BUTTON' && n.classList.contains('btn-primary')) ? '#3B82F6' : '#FAFAFA'; });\n               el.focus(); if (step.action === 'click') el.click();\n               if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {\n                   el.style.borderColor = '#3B82F6';\n                   el.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.15)';\n                   el.style.background = '#FFF';\n               }\n            }\n          }, 150);\n        }, 800);\n      }\n    }, ms);\n  });\n  if (${!!options.loop}) {\n    const maxTime = Math.max(...timeline.map(s => parseFloat(s.time.replace('s','')))) * 1000;\n    setTimeout(() => location.reload(), maxTime + 2500);\n  }\n});\n</script>\n`;
                    animatedHtml = animatedHtml.replace('</body>', `${engineScript}\n</body>`);
                }

            } catch (e) { console.error('Error parsing timeline config', e); }
        }

        const outPath = path.join(outputDir, 'animated.html');
        fs.writeFileSync(outPath, animatedHtml, 'utf-8');
        console.log(`\nSuccess! Animated HTML saved to ${outPath}`);
    } catch (error: any) {
        console.error('Failed to animate UI:', error.message);
        process.exit(1);
    }
}
