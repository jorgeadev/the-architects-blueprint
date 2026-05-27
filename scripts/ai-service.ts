import { GoogleGenerativeAI } from "@google/generative-ai";
import { GEMINI_MODEL, DEEPSEEK_MODEL, GROK_MODEL, OPENROUTER_FREE_MODELS } from "./constants";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY as string;
const GROK_API_KEY = process.env.GROK_API_KEY as string;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY as string;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY as string;

// Initialize Google SDK once
let genAI: GoogleGenerativeAI | null = null;
if (GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
}

export async function generateWithGemini(prompt: string): Promise<string> {
    if (!genAI) {
        throw new Error("GEMINI_API_KEY is not configured.");
    }
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const result = await model.generateContent(prompt);
    return result.response.text();
}

export async function generateWithDeepSeek(prompt: string): Promise<string> {
    if (!DEEPSEEK_API_KEY) {
        throw new Error("DEEPSEEK_API_KEY is not defined in the environment.");
    }

    console.log("   -> Triggering DeepSeek Fallback...");
    const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
            model: DEEPSEEK_MODEL,
            messages: [{ role: "user", content: prompt }],
        }),
    });

    if (!response.ok) {
        throw new Error(`DeepSeek API Error: ${response.status} - ${await response.text()}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

export async function generateWithGrok(prompt: string): Promise<string> {
    if (!GROK_API_KEY) {
        throw new Error("GROK_API_KEY is not defined in the environment.");
    }

    console.log("   -> Triggering xAI Grok Fallback...");
    const response = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${GROK_API_KEY}`,
        },
        body: JSON.stringify({
            model: GROK_MODEL,
            messages: [{ role: "user", content: prompt }],
        }),
    });

    if (!response.ok) {
        throw new Error(`Grok API Error: ${response.status} - ${await response.text()}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

export async function generateWithOpenRouter(prompt: string): Promise<string> {
    if (!OPENROUTER_API_KEY) {
        throw new Error("OPENROUTER_API_KEY is not defined in the environment.");
    }

    const modelStr =
        OPENROUTER_FREE_MODELS[Math.floor(Math.random() * OPENROUTER_FREE_MODELS.length)];
    console.log(`   -> Triggering OpenRouter Fallback using model: ${modelStr}...`);

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        },
        body: JSON.stringify({
            model: modelStr,
            messages: [{ role: "user", content: prompt }],
        }),
    });

    if (!response.ok) {
        throw new Error(`OpenRouter API Error: ${response.status} - ${await response.text()}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}
