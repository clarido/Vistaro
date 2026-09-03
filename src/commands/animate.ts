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
            // Inject cursor DOM and CSS natively (top left origin for JS engine coordinate base)
            const cursorCss = options.cursor === 'mac'
                ? `\n<style>\n#anim-cli-cursor { position: fixed; top: 0; left: 0; transform: translate(50vw, 120vh); width: 28px; height: 28px; z-index: 99999; pointer-events: none; background: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%230F172A" stroke="white" stroke-width="1.5"><path d="M4 2v20l5.83-5.83 3.96 8.5 3.65-1.7-3.96-8.5H22L4 2z"/></svg>') no-repeat; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3)); transform-origin: top left; transition: transform 0.8s cubic-bezier(0.16, 1, 0.3, 1); }\n</style>\n`
                : `\n<style>\n#anim-cli-cursor { position: fixed; top: 0; left: 0; transform: translate(50vw, 120vh); width: 20px; height: 20px; z-index: 99999; pointer-events: none; background: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white" stroke="black" stroke-width="1"><path d="M2 2l20 10-8 2-2 8z"/></svg>') no-repeat; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3)); transform-origin: top left; transition: transform 0.8s cubic-bezier(0.16, 1, 0.3, 1); }\n</style>\n`;

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
                    const masterCss = `\n<style>\n#anim-cli-subtitle-layer { position: fixed; bottom: 40px; left: 0; right: 0; display: flex; justify-content: center; z-index: 99998; pointer-events: none; padding: 0 40px; }\n.anim-cli-sub-item { position: absolute; bottom: 0; background: rgba(20,20,20,0.75); color: white; padding: 16px 32px; border-radius: 12px; font-family: -apple-system, sans-serif; font-size: 20px; line-height: 1.4; text-align: center; max-width: 800px; box-shadow: 0 20px 40px -8px rgba(0,0,0,0.5); opacity: 0; font-weight: 500; letter-spacing: 0.3px; backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,0.15); }\n@keyframes anim-cli-subFade { 0% { opacity: 0; transform: translateY(15px) scale(0.95); animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); } 10%, 90% { opacity: 1; transform: translateY(0) scale(1); animation-timing-function: cubic-bezier(0.7, 0, 0.84, 0); } 100% { opacity: 0; transform: translateY(-10px) scale(0.95); } }${subsCss}\n</style>\n`;
                    animatedHtml = animatedHtml.replace('</body>', `    <div id="anim-cli-subtitle-layer">${subsHtml}</div>\n</body>`);
                    animatedHtml = animatedHtml.replace('</head>', `${masterCss}</head>`);
                }

                // INJECT V4 INTERACTION ENGINE (cursor, click ripples, spotlight highlight, camera pans, scroll)
                {
                    const effectsCss = `\n<style>\n#anim-cli-highlight { position: fixed; border-radius: 10px; border: 2px solid #3B82F6; box-shadow: 0 0 0 4px rgba(59,130,246,0.18), 0 0 28px rgba(59,130,246,0.35); pointer-events: none; z-index: 99996; opacity: 0; transition: left 0.5s cubic-bezier(0.16,1,0.3,1), top 0.5s cubic-bezier(0.16,1,0.3,1), width 0.5s cubic-bezier(0.16,1,0.3,1), height 0.5s cubic-bezier(0.16,1,0.3,1); }\n#anim-cli-highlight.anim-cli-pulse { animation: anim-cli-highlightPulse 1.3s cubic-bezier(0.16,1,0.3,1) forwards; }\n@keyframes anim-cli-highlightPulse { 0% { opacity: 0; } 15% { opacity: 1; } 75% { opacity: 1; } 100% { opacity: 0; } }\n.anim-cli-ripple { position: fixed; width: 14px; height: 14px; margin-left: -7px; margin-top: -7px; border-radius: 50%; background: rgba(59,130,246,0.35); border: 2px solid rgba(59,130,246,0.65); pointer-events: none; z-index: 99997; animation: anim-cli-rippleAnim 0.6s cubic-bezier(0.16,1,0.3,1) forwards; }\n@keyframes anim-cli-rippleAnim { 0% { width: 14px; height: 14px; margin-left: -7px; margin-top: -7px; opacity: 0.9; } 100% { width: 80px; height: 80px; margin-left: -40px; margin-top: -40px; opacity: 0; } }\n</style>\n`;

                    const engineScript = `
<script>
document.addEventListener('DOMContentLoaded', () => {
  const stage = document.body;
  stage.style.transformOrigin = 'center center';
  stage.style.transition = 'transform 16s cubic-bezier(0.16, 1, 0.3, 1)';
  stage.style.transform = 'scale(1.025)';

  // A transformed <body> becomes the containing block for its position:fixed descendants,
  // which would double-apply the camera/zoom transform to the cursor/highlight/ripple overlays.
  // Reparent them to <html> (never transformed) so they stay correctly viewport-relative.
  const overlayRoot = document.documentElement;

  const timeline = ${JSON.stringify(cfg)};
  const cursor = document.getElementById('anim-cli-cursor');
  const subtitleLayer = document.getElementById('anim-cli-subtitle-layer');
  [cursor, subtitleLayer].forEach((el) => { if (el) overlayRoot.appendChild(el); });

  function ripple(x, y) {
    const r = document.createElement('div');
    r.className = 'anim-cli-ripple';
    r.style.left = x + 'px';
    r.style.top = y + 'px';
    overlayRoot.appendChild(r);
    setTimeout(() => r.remove(), 700);
  }

  function getHighlightBox() {
    let h = document.getElementById('anim-cli-highlight');
    if (!h) {
      h = document.createElement('div');
      h.id = 'anim-cli-highlight';
      overlayRoot.appendChild(h);
    }
    return h;
  }

  function highlight(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const h = getHighlightBox();
    h.style.left = (rect.left - 6) + 'px';
    h.style.top = (rect.top - 6) + 'px';
    h.style.width = (rect.width + 12) + 'px';
    h.style.height = (rect.height + 12) + 'px';
    h.classList.remove('anim-cli-pulse');
    void h.offsetWidth;
    h.classList.add('anim-cli-pulse');
  }

  timeline.forEach((step, index) => {
    const ms = parseFloat(step.time.replace('s', '')) * 1000;

    if (step.action === 'camera') {
      setTimeout(() => {
        let x = step.x != null ? step.x : '0px';
        let y = step.y != null ? step.y : '0px';
        if (typeof x === 'number') x = x + 'px';
        if (typeof y === 'number') y = y + 'px';
        const scale = step.scale || 1;
        if (step.target) {
          const el = document.querySelector(step.target);
          if (el) {
            const r = el.getBoundingClientRect();
            const cx = r.left + r.width / 2 - window.innerWidth / 2;
            const cy = r.top + r.height / 2 - window.innerHeight / 2;
            x = (-cx) + 'px';
            y = (-cy) + 'px';
          }
        }
        stage.style.transition = 'transform ' + (step.duration || 2.5) + 's cubic-bezier(0.65, 0, 0.35, 1)';
        stage.style.transform = 'scale(' + scale + ') translate(' + x + ', ' + y + ')';
      }, ms);
      return;
    }

    if (step.action === 'scroll' && step.target) {
      setTimeout(() => {
        const el = document.querySelector(step.target);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, ms);
      return;
    }

    if (!step.target || step.target === 'body') return;

    setTimeout(() => {
      const el = document.querySelector(step.target);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      let tx = rect.left + rect.width / 2;
      let ty = rect.top + rect.height / 2;
      if (step.xOffset) tx += parseFloat(step.xOffset);
      if (step.yOffset) ty += parseFloat(step.yOffset);
      const transitionSpeed = index === 0 ? '1.4s' : '0.8s';
      if (cursor) {
        cursor.style.transition = 'all ' + transitionSpeed + ' cubic-bezier(0.16, 1, 0.3, 1)';
        cursor.style.transform = 'translate(' + tx + 'px, ' + ty + 'px)';
      }
      setTimeout(() => {
        if (step.action === 'click' || step.action === 'focus' || step.action === 'type' || step.action === 'highlight') {
          highlight(el);
        }
        if (cursor) cursor.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(0.85)';
        setTimeout(() => {
          if (cursor) cursor.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(1)';
          if (step.action === 'click' || step.action === 'focus' || step.action === 'type') {
            document.querySelectorAll('.input, button').forEach(n => {
              n.style.borderColor = '#E2E8F0';
              n.style.boxShadow = 'none';
              n.style.background = (n.tagName === 'BUTTON' && n.classList.contains('btn-primary')) ? '#3B82F6' : '#FAFAFA';
            });
            if (step.action === 'click') {
              ripple(tx, ty);
              el.focus();
              el.click();
            } else {
              el.focus();
            }
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
              el.style.borderColor = '#3B82F6';
              el.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.15)';
              el.style.background = '#FFF';
            }
          }
          if (step.action === 'type' && step.value) {
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') { el.value = ''; }
            else { el.innerText = ''; }
            let i = 0;
            const intId = setInterval(() => {
              if (i < step.value.length) {
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') { el.value += step.value[i]; }
                else { el.innerText += step.value[i]; }
                i++;
              } else {
                clearInterval(intId);
              }
            }, 40);
          }
        }, 150);
      }, 800);
    }, ms);
  });

  if (${!!options.loop}) {
    const maxTime = Math.max(...timeline.map(s => parseFloat(s.time.replace('s', '')))) * 1000;
    setTimeout(() => location.reload(), maxTime + 2500);
  }
});
</script>
`;
                    animatedHtml = animatedHtml.replace('</head>', `${effectsCss}</head>`);
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
