const fs = require('fs');
const path = require('path');

const outputDir = path.resolve(__dirname);
const cursor = 'mac';
const loop = false;

let animatedHtml = fs.readFileSync(path.join(outputDir, 'index.html'), 'utf8');

// Inject cursor DOM and CSS
const cursorCss = `\n<style>\n#anim-cli-cursor { position: fixed; top: 0; left: 0; transform: translate(50vw, 120vh); width: 28px; height: 28px; z-index: 99999; pointer-events: none; background: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%230F172A" stroke="white" stroke-width="1.5"><path d="M4 2v20l5.83-5.83 3.96 8.5 3.65-1.7-3.96-8.5H22L4 2z"/></svg>') no-repeat; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3)); transform-origin: top left; transition: transform 0.8s cubic-bezier(0.16, 1, 0.3, 1); }\n</style>\n`;
animatedHtml = animatedHtml.replace('</body>', `    <div id="anim-cli-cursor"></div>\n</body>`);
animatedHtml = animatedHtml.replace('</head>', `${cursorCss}</head>`);

// Subtitles & Engine
const cfg = JSON.parse(fs.readFileSync(path.join(outputDir, 'anim.config.json'), 'utf8'));
let subsHtml = '';
let subsCss = '';
cfg.forEach((step, index) => {
    if (step.subtitle) {
        const tFloat = parseFloat(step.time.replace('s', ''));
        let nextT = tFloat + 4;
        for(let i = index+1; i < cfg.length; i++) {
             if (cfg[i].subtitle) { nextT = parseFloat(cfg[i].time.replace('s', '')); break; }
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

const engineScript = `\n<script>\ndocument.addEventListener('DOMContentLoaded', () => {\n  document.body.style.transformOrigin = 'center center';\n  document.body.style.transform = 'scale(1.03)';\n  document.body.style.transition = 'transform 15s ease-out';\n  const timeline = ${JSON.stringify(cfg)};\n  const cursor = document.getElementById('anim-cli-cursor');\n  if (!cursor) return;\n  timeline.forEach((step, index) => {\n    if (!step.target || step.target === 'body') return;\n    const ms = parseFloat(step.time.replace('s','')) * 1000;\n    setTimeout(() => {\n      const el = document.querySelector(step.target);\n      if (el) {
        const rect = el.getBoundingClientRect();
        let tx = rect.left + rect.width / 2;
        let ty = rect.top + rect.height / 2;
        if (step.xOffset) tx += parseFloat(step.xOffset);
        if (step.yOffset) ty += parseFloat(step.yOffset);
        const transitionSpeed = index === 0 ? '1.4s' : '0.8s';
        cursor.style.transition = 'all ' + transitionSpeed + ' cubic-bezier(0.16, 1, 0.3, 1)';
        cursor.style.transform = 'translate(' + tx + 'px, ' + ty + 'px)';\n        setTimeout(() => {\n          cursor.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(0.85)';\n          setTimeout(() => {\n            cursor.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(1)';\n            if (step.action === 'focus' || step.action === 'click' || step.action === 'type') {\n               document.querySelectorAll('.input, button').forEach(n => { n.style.borderColor = '#E2E8F0'; n.style.boxShadow = 'none'; n.style.background = (n.tagName==='BUTTON' && n.classList.contains('btn-primary')) ? '#3B82F6' : '#FAFAFA'; });\n               if (step.action === 'click' && typeof el.onclick === 'function') { el.onclick(); } else { el.focus(); if (step.action === 'click') el.click(); }\n               if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {\n                   el.style.borderColor = '#3B82F6';\n                   el.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.15)';\n                   el.style.background = '#FFF';\n               }\n            }\n            if (step.action === 'type' && step.value) {\n               if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') { el.value = ''; }\n               else { el.innerText = ''; }\n               let i = 0;\n               let intId = setInterval(() => {\n                   if (i < step.value.length) {\n                       if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') { el.value += step.value[i]; }\n                       else { el.innerText += step.value[i]; }\n                       i++;\n                   } else {\n                       clearInterval(intId);\n                   }\n               }, 40);\n            }\n          }, 150);\n        }, 800);\n      }\n    }, ms);\n  });\n});\n</script>\n`;
animatedHtml = animatedHtml.replace('</body>', `${engineScript}\n</body>`);

fs.writeFileSync(path.join(outputDir, 'animated.html'), animatedHtml, 'utf8');
console.log('Successfully written animated.html');
