import { GoogleGenerativeAI } from '@google/generative-ai';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';

export interface ProviderConfig {
    provider: 'gemini' | 'claude';
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
        if (!apiKey) throw new Error('GEMINI_API_KEY is required in .env');
        
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro", systemInstruction: systemPrompt });

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

        const result = await model.generateContent([{role: 'user', parts: contents}]);
        return result.response.text();
    } else if (config.provider === 'claude') {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required in .env');
        
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

        const msg = await anthropic.messages.create({
            model: 'claude-3-7-sonnet-20250219',
            max_tokens: 8000,
            system: systemPrompt,
            messages: [{ role: 'user', content }]
        });

        // @ts-ignore
        return msg.content[0].text;
    }

    throw new Error('Unsupported provider: ' + config.provider);
}
