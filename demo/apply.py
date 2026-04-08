import json
import os

output_dir = os.path.dirname(os.path.abspath(__file__))

with open(os.path.join(output_dir, 'index.html'), 'r') as f:
    animated_html = f.read()

cursor_css = "\n<style>\n#anim-cli-cursor { position: fixed; top: 0; left: 0; transform: translate(50vw, 120vh); width: 28px; height: 28px; z-index: 99999; pointer-events: none; background: url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"%230F172A\" stroke=\"white\" stroke-width=\"1.5\"><path d=\"M4 2v20l5.83-5.83 3.96 8.5 3.65-1.7-3.96-8.5H22L4 2z\"/></svg>') no-repeat; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3)); transform-origin: top left; transition: transform 0.8s cubic-bezier(0.16, 1, 0.3, 1); }\n</style>\n"
animated_html = animated_html.replace('</body>', f'    <div id="anim-cli-cursor"></div>\n</body>')
animated_html = animated_html.replace('</head>', f'{cursor_css}</head>')

with open(os.path.join(output_dir, 'anim.config.json'), 'r') as f:
    cfg = json.load(f)

subs_html = ""
subs_css = ""
for index, step in enumerate(cfg):
    if step.get('subtitle'):
        t_float = float(step['time'].replace('s', ''))
        next_t = t_float + 4
        for i in range(index + 1, len(cfg)):
            if cfg[i].get('subtitle'):
                next_t = float(cfg[i]['time'].replace('s', ''))
                break
        duration = max(1, next_t - t_float)
        subs_html += f'\n<div class="anim-cli-sub-item anim-sub-{index}">{step["subtitle"]}</div>'
        subs_css += f'\n.anim-sub-{index} {{ opacity: 0; animation: anim-cli-subFade {duration}s ease {t_float}s forwards; }}'

if subs_html:
    master_css = "\n<style>\n#anim-cli-subtitle-layer { position: fixed; bottom: 40px; left: 0; right: 0; display: flex; justify-content: center; z-index: 99998; pointer-events: none; padding: 0 40px; }\n.anim-cli-sub-item { position: absolute; bottom: 0; background: rgba(20,20,20,0.75); color: white; padding: 16px 32px; border-radius: 12px; font-family: -apple-system, sans-serif; font-size: 20px; line-height: 1.4; text-align: center; max-width: 800px; box-shadow: 0 20px 40px -8px rgba(0,0,0,0.5); opacity: 0; font-weight: 500; letter-spacing: 0.3px; backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,0.15); }\n@keyframes anim-cli-subFade { 0% { opacity: 0; transform: translateY(15px) scale(0.95); animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); } 10%, 90% { opacity: 1; transform: translateY(0) scale(1); animation-timing-function: cubic-bezier(0.7, 0, 0.84, 0); } 100% { opacity: 0; transform: translateY(-10px) scale(0.95); } }" + subs_css + "\n</style>\n"
    animated_html = animated_html.replace('</body>', f'    <div id="anim-cli-subtitle-layer">{subs_html}</div>\n</body>')
    animated_html = animated_html.replace('</head>', f'{master_css}</head>')

cfg_json = json.dumps(cfg)
engine_script = f"""
<script>
document.addEventListener('DOMContentLoaded', () => {{
  
  const timeline = {cfg_json};
  const cursor = document.getElementById('anim-cli-cursor');
  if (!cursor) return;
  timeline.forEach((step, index) => {{
    if (!step.target || step.target === 'body') return;
    const ms = parseFloat(step.time.replace('s','')) * 1000;
    setTimeout(() => {{
      const el = document.querySelector(step.target);
      if (el) {{
        const rect = el.getBoundingClientRect();
        let tx = rect.left + rect.width / 2;
        let ty = rect.top + rect.height / 2;
        if (step.xOffset) tx += parseFloat(step.xOffset);
        if (step.yOffset) ty += parseFloat(step.yOffset);
        const transitionSpeed = index === 0 ? '1.4s' : '0.8s';
        cursor.style.transition = 'all ' + transitionSpeed + ' cubic-bezier(0.16, 1, 0.3, 1)';
        cursor.style.transform = 'translate(' + tx + 'px, ' + ty + 'px)';
        setTimeout(() => {{
          cursor.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(0.85)';
          setTimeout(() => {{
            cursor.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(1)';
            if (step.action === 'focus' || step.action === 'click' || step.action === 'type') {{
               document.querySelectorAll('.input, button').forEach(n => {{ n.style.borderColor = '#E2E8F0'; n.style.boxShadow = 'none'; n.style.background = (n.tagName==='BUTTON' && n.classList.contains('btn-primary')) ? '#3B82F6' : '#FAFAFA'; }});
               if (step.action === 'click' && typeof el.onclick === 'function') {{ el.onclick(); }} else {{ el.focus(); if (step.action === 'click') el.click(); }}
               if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {{
                   el.style.borderColor = '#3B82F6';
                   el.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.15)';
                   el.style.background = '#FFF';
               }}
            }}
            if (step.action === 'type' && step.value) {{
               if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {{ el.value = ''; }}
               else {{ el.innerText = ''; }}
               let i = 0;
               let intId = setInterval(() => {{
                   if (i < step.value.length) {{
                       if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {{ el.value += step.value[i]; }}
                       else {{ el.innerText += step.value[i]; }}
                       i++;
                   }} else {{
                       clearInterval(intId);
                   }}
               }}, 40);
            }}
          }}, 150);
        }}, 800);
      }}
    }}, ms);
  }});
}});
</script>
"""

animated_html = animated_html.replace('</body>', f'{engine_script}\n</body>')

with open(os.path.join(output_dir, 'animated.html'), 'w') as f:
    f.write(animated_html)

print("Successfully written animated.html")
