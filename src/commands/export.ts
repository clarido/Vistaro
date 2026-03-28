import { chromium } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';

export async function exportCommand(outputDir: string, options: { duration: string, output: string, device: string, voiceover?: string, theme?: string, width?: string, height?: string }) {
    console.log(`Starting video export. Target duration: ${options.duration}s. Device: ${options.device}`);
    
    // We expect the animated HTML to be either animated.html or index.html
    let htmlPath = path.resolve(outputDir, 'animated.html');
    if (!fs.existsSync(htmlPath)) {
        htmlPath = path.resolve(outputDir, 'index.html');
        if (!fs.existsSync(htmlPath)) {
            console.error(`Error: Could not find animated.html or index.html in ${outputDir}`);
            process.exit(1);
        }
    }

    const browser = await chromium.launch({ headless: true });
    
    // Temporary directory for the raw webm video output by Playwright
    const tempVideoDir = path.join(outputDir, '.temp-video');
    
    const isMobile = options.device === 'mobile';
    const vWidth = options.width ? parseInt(options.width) : (isMobile ? 390 : 1280);
    const vHeight = options.height ? parseInt(options.height) : (isMobile ? 844 : 720);

    const context = await browser.newContext({
        viewport: { width: vWidth, height: vHeight },
        colorScheme: options.theme === 'dark' ? 'dark' : 'light',
        recordVideo: {
            dir: tempVideoDir,
            size: { width: vWidth, height: vHeight }
        }
    });

    const page = await context.newPage();
    const fileUrl = `file://${htmlPath}`;
    
    console.log(`Opening ${fileUrl} in headless browser...`);
    await page.goto(fileUrl, { waitUntil: 'load' });
    
    const durationMs = parseInt(options.duration) * 1000;
    if (isNaN(durationMs) || durationMs <= 0) {
        console.error(`Error: Invalid duration "${options.duration}". Must be a positive number of seconds.`);
        process.exit(1);
    }
    console.log(`Recording for ${options.duration} seconds...`);
    
    // Wait for the requested duration to let animations play
    await page.waitForTimeout(durationMs);

    // Close page to flush video to disk
    await page.close();
    await context.close();
    await browser.close();

    // Find the generated webm file
    const files = fs.readdirSync(tempVideoDir).filter(f => f.endsWith('.webm'));
    if (files.length === 0) {
        console.error('Error: Video recording failed, no .webm found.');
        process.exit(1);
    }
    const webmFile = path.join(tempVideoDir, files[0]);

    // Setup FFmpeg to convert to mp4
    const outputFile = path.resolve(options.output);
    console.log(`Converting to MP4: ${outputFile}...`);

    try {
        if (!ffmpegStatic) {
            throw new Error('ffmpeg-static binary not found');
        }

        let ffmpegArgs: string[] = [];
        if (outputFile.toLowerCase().endsWith('.gif')) {
            console.log(`Optimizing frames for high-quality GIF export...`);
            // Use FFmpeg palettegen for crisp, optimized web GIFs at 15fps
            ffmpegArgs = ['-y', '-i', webmFile, '-vf', 'fps=15,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse', '-loop', '0', outputFile];
        } else {
            ffmpegArgs = ['-y', '-i', webmFile, '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', outputFile];

            if (options.voiceover && fs.existsSync(options.voiceover)) {
                console.log(`Generating TTS audio from ${options.voiceover}...`);
                const scriptPath = path.resolve(options.voiceover);
                const scriptText = fs.readFileSync(scriptPath, 'utf8');
                let audioOut = path.join(tempVideoDir, 'audio.aiff');

                const openAiKey = process.env.OPENAI_API_KEY;
                if (openAiKey) {
                    console.log(`OPENAI_API_KEY detected. Generating high-quality audio using OpenAI TTS-1...`);
                    audioOut = path.join(tempVideoDir, 'audio.mp3');
                    const response = await fetch('https://api.openai.com/v1/audio/speech', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${openAiKey}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            model: 'tts-1',
                            input: scriptText,
                            voice: 'alloy'
                        })
                    });

                    if (!response.ok) {
                        const errorText = await response.text();
                        console.error(`OpenAI TTS Error: ${errorText}`);
                        console.log(`Falling back to native macOS 'say'...`);
                        audioOut = path.join(tempVideoDir, 'audio.aiff');
                        execFileSync('say', ['-f', scriptPath, '-o', audioOut]);
                    } else {
                        const buffer = await response.arrayBuffer();
                        fs.writeFileSync(audioOut, Buffer.from(buffer));
                    }
                } else {
                    console.log(`Falling back to native macOS 'say'. Provide OPENAI_API_KEY for hyper-realistic voiceovers.`);
                    execFileSync('say', ['-f', scriptPath, '-o', audioOut]);
                }

                // Update FFmpeg args to mux video and audio
                ffmpegArgs = ['-y', '-i', webmFile, '-i', audioOut, '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-c:a', 'aac', outputFile];
            }
        }

        // Run FFmpeg with safe argument passing (no shell interpolation)
        execFileSync(ffmpegStatic, ffmpegArgs, { stdio: 'ignore' });
        
        console.log(`\nSuccess! Video exported successfully to ${outputFile}`);
    } catch (error: any) {
        console.error('Video conversion failed:', error.message);
    } finally {
        // Cleanup temp file
        try {
            fs.rmSync(tempVideoDir, { recursive: true, force: true });
        } catch (e) {}
    }
}
