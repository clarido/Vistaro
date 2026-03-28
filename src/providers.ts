import { GoogleGenerativeAI } from '@google/generative-ai';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';

export interface ProviderConfig {
    provider: 'gemini' | 'claude';
    model?: string;
}

const DEFAULT_MODELS = {
    gemini: 'gemini-2.5-pro',
    claude: 'claude-sonnet-4-6',
} as const;

/**
 * Auto-detect provider based on available API keys.
 * Returns the explicitly requested provider, or falls back to whichever key is available.
 */
export function resolveProvider(requested: string): 'gemini' | 'claude' {
    if (requested === 'gemini' && process.env.GEMINI_API_KEY) return 'gemini';
    if (requested === 'claude' && process.env.ANTHROPIC_API_KEY) return 'claude';

    // If the requested provider's key is missing, try the other one
    if (requested === 'gemini' && !process.env.GEMINI_API_KEY && process.env.ANTHROPIC_API_KEY) {
        console.log(`Note: GEMINI_API_KEY not found, falling back to claude provider.`);
        return 'claude';
    }
    if (requested === 'claude' && !process.env.ANTHROPIC_API_KEY && process.env.GEMINI_API_KEY) {
        console.log(`Note: ANTHROPIC_API_KEY not found, falling back to gemini provider.`);
        return 'gemini';
    }

    // Neither key found — return the requested one and let generateContent throw with a helpful message
    return requested as 'gemini' | 'claude';
}

export async function generateContent(
    config: ProviderConfig,
    systemPrompt: string,
    userPrompt: string,
    imagePath?: string
): Promise<string> {
    if (process.env.BYPASS_LLM === 'true') {
         const match = userPrompt.match(/Base HTML:\n([\s\S]*)\n\nAnimation Request:/);
         if (match) return match[1];
         return "<html><body>Bypass Mock</body></html>";
    }
    if (config.provider === 'gemini') {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            throw new Error(
                'GEMINI_API_KEY not found.\n' +
                'Set it via environment variable or in a .env file:\n' +
                '  export GEMINI_API_KEY=your-key-here\n' +
                'Or use --provider claude with ANTHROPIC_API_KEY instead.'
            );
        }

        const modelId = config.model || process.env.GEMINI_MODEL || DEFAULT_MODELS.gemini;
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: modelId, systemInstruction: systemPrompt });

        const contents: any[] = [{ text: userPrompt }];

        if (imagePath) {
             const data = fs.readFileSync(imagePath);
             contents.push({
                 inlineData: {
                     data: data.toString("base64"),
                     mimeType: imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg'
                 }
             });
        }

        const result = await model.generateContent({ contents: [{ role: 'user', parts: contents }] });
        return result.response.text();
    } else if (config.provider === 'claude') {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            throw new Error(
                'ANTHROPIC_API_KEY not found.\n' +
                'Set it via environment variable or in a .env file:\n' +
                '  export ANTHROPIC_API_KEY=your-key-here\n' +
                'Or use --provider gemini with GEMINI_API_KEY instead.'
            );
        }
        
        const anthropic = new Anthropic({ apiKey });
        const content: any[] = [];
        
        if (imagePath) {
            const data = fs.readFileSync(imagePath).toString("base64");
            const mediaType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
            content.push({
                type: 'image',
                source: { type: 'base64', media_type: mediaType as any, data }
            });
        }
        
        content.push({ type: 'text', text: userPrompt });

        const modelId = config.model || process.env.CLAUDE_MODEL || DEFAULT_MODELS.claude;
        const msg = await anthropic.messages.create({
            model: modelId,
            max_tokens: 8000,
            system: systemPrompt,
            messages: [{ role: 'user', content }]
        });

        const block = msg.content[0];
        if (block.type !== 'text') throw new Error('Unexpected response type: ' + block.type);
        return block.text;
    }

    throw new Error('Unsupported provider: ' + config.provider);
}
