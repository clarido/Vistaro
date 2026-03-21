import * as fs from 'fs';
import * as path from 'path';
import { generateContent, ProviderConfig } from '../providers';

function getSystemPrompt(abstraction: string, device: string, framework: string, theme: string): string {
    let abstractionRule = "";
    if (abstraction === 'moderate') {
        abstractionRule = "8. MODERATE ABSTRACTION: Simplify paragraphs into horizontal skeleton lines or generic placeholder text. Remove highly specific data, keeping only structural icons, major buttons, and titles.";
    } else if (abstraction === 'high') {
        abstractionRule = "8. HIGH ABSTRACTION (WIREFRAME): Heavily abstract the UI. Replace almost all text, paragraphs, and labels with solid gray rectangles (skeleton loaders). Remove images and complex icons. Keep only the absolute highest-level layout blocks, primary navigation layout, and blank geometric representations of buttons.";
    } else {
        abstractionRule = "8. NO ABSTRACTION: Replicate the texts and visual elements in the screenshot as a 1-to-1 match as accurately as possible.";
    }

    const isReact = framework === 'react';
    const frameworkRules = isReact
        ? `1. Output ONLY valid React TSX code. Do NOT wrap it in markdown block quotes (e.g. \`\`\`tsx).\n2. Use Tailwind CSS classes for styling (e.g., className="flex items-center").\n3. Create a single, default-exported functional component.`
        : `1. Output ONLY valid HTML code. Do NOT wrap it in markdown block quotes (e.g. \`\`\`html) or any other text.\n2. Include all necessary CSS within a <style> tag in the <head>.\n3. Use modern, beautiful CSS (flexbox, grid, soft shadows, rounded corners).`;

    const basePrompt = `You are an expert UI developer. Your goal is to convert the provided screenshot into a pristine, fully responsive HTML/CSS structure. CRITICAL: Include flexible dual-theme support (using Tailwind dark: variants or CSS prefers-color-scheme media queries) since the pipeline will dynamically trigger the theme in [${theme}] mode rendering via Playwright environment parameters.`;

    return `${basePrompt}

RULES:
${frameworkRules}
4. Do NOT use external images or fonts that might not load; stick to system fonts and CSS shapes/colors.
5. EVERY significant structural element (cards, buttons, headers, text blocks) MUST have a meaningful semantic \`id\` or \`class\` attribute. This is critical because in the next step, we will animate these elements by name.
6. The HTML should be visually constrained correctly for the requested device viewport: ${device === 'mobile' ? 'Mobile App View (390x844)' : 'Desktop Web View (1280x720)'}.
7. Focus on the core layout and aesthetic; simplify text or use generic placeholders if necessary, but keep the visual structure intact.
${abstractionRule}`;
}

export async function extractCommand(imagePath: string, outputDir: string, options: { provider: string, abstraction: string, device: string, framework: string, theme: string }) {
    console.log(`Starting extraction using provider: ${options.provider} (Framework: ${options.framework}, Abstraction: ${options.abstraction}, Device: ${options.device}, Theme: ${options.theme})`);
    
    const imgResolved = path.resolve(imagePath);
    if (!fs.existsSync(imgResolved)) {
        console.error(`Error: Image not found at ${imgResolved}`);
        process.exit(1);
    }

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    try {
        console.log('Analyzing image and generating HTML essence... (this may take a minute)');
        const config: ProviderConfig = { provider: options.provider as 'gemini' | 'claude' };
        
        const prompt = getSystemPrompt(options.abstraction || 'none', options.device || 'desktop', options.framework || 'html', options.theme || 'light');
        let htmlContent = await generateContent(
            config,
            prompt,
            `Please convert this screenshot into a ${options.framework === 'react' ? 'React component' : 'HTML'} wrapper. ${options.framework==='react'?'Remember to use Tailwind for React!':''}`,
            imgResolved
        );

        // Clean up markdown formatting if the LLM hallucinated it despite instructions
        htmlContent = htmlContent.trim();
        if (htmlContent.startsWith('```html')) {
            htmlContent = htmlContent.replace(/^```html\n/, '').replace(/\n```$/, '');
        } else if (htmlContent.startsWith('```')) {
            htmlContent = htmlContent.replace(/^```\n/, '').replace(/\n```$/, '');
        }

        const outPath = path.join(outputDir, options.framework === 'react' ? 'index.tsx' : 'index.html');
        fs.writeFileSync(outPath, htmlContent, 'utf-8');
        console.log(`\nSuccess! Extracted UI saved to ${outPath}`);
    } catch (error: any) {
        console.error('Failed to extract UI essence:', error.message);
        process.exit(1);
    }
}
