import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
 
type ProviderName = "gemini" | "openai" | "claude" | "openrouter";
 
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
 
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}
 
class ProviderError extends Error {
  provider: ProviderName;
  status: number;
 
  constructor(provider: ProviderName, status: number, message: string) {
    super(message);
    this.provider = provider;
    this.status = status;
  }
}
 
function cleanJsonText(text: string) {
  let cleaned = String(text || "").trim();
 
  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
 
  const firstObject = cleaned.indexOf("{");
  const lastObject = cleaned.lastIndexOf("}");
  const firstArray = cleaned.indexOf("[");
  const lastArray = cleaned.lastIndexOf("]");
 
  // Prefer the full object format: { "questions": [...] }
  if (firstObject !== -1 && lastObject !== -1 && lastObject > firstObject) {
    return cleaned.slice(firstObject, lastObject + 1).trim();
  }
 
  // Fallback only if the model returned a raw array
  if (firstArray !== -1 && lastArray !== -1 && lastArray > firstArray) {
    return cleaned.slice(firstArray, lastArray + 1).trim();
  }
 
  return cleaned;
}
 
function buildPrompt(startPage: number | null, endPage: number | null) {
  const pageInstruction =
    startPage && endPage
      ? `Focus only on pages ${startPage} to ${endPage} if page numbers are visible.`
      : "Extract all clear MCQs visible in the uploaded PDF.";
 
  return `
You are converting a medical MCQ PDF into JSON for the Quizard app.
 
${pageInstruction}
 
Return ONLY valid JSON.
Do not add markdown.
Do not add text before or after the JSON.
 
Required output format:
{
  "questions": [
    {
      "questionNumber": 1,
      "question": "Full question text. Preserve line breaks, headings, bold text using HTML when needed, and tables using valid HTML table tags.",
      "options": ["option text only without A/B/C prefix", "option text only without A/B/C prefix", "option text only without A/B/C prefix", "option text only without A/B/C prefix"],
      "correctAnswerIndex": 0,
      "explanation": "Full explanation. Preserve structure, headings, bolding, line breaks, and tables using HTML."
    }
  ]
}
 
Rules:
- Return ONLY valid JSON.
- Return an object with a "questions" array.
- Do not return a raw array.
- Do not add markdown.
- Do not add text before or after JSON.
- Each question must include ONLY these fields: questionNumber, question, options, correctAnswerIndex, explanation.
- Do not include imageUrl, imageUrls, explanationImageUrl, or explanationImageUrls.
- Images will be imported separately using the Image Bulk Import feature.
- questionNumber must start at 1 inside this chunk and increase by 1.
- options must be an array of answer text only. Do not include "A.", "B.", "C.", etc. inside option text.
- correctAnswerIndex is zero-based: A=0, B=1, C=2, D=3, E=4.
- Do not hallucinate the correct answer.
- If the correct answer is not visible or cannot be confidently determined, do not include that MCQ in the questions array.
- If the explanation is not visible or cannot be confidently extracted, do not include that MCQ in the questions array.
- If the question stem (the clinical scenario / the actual question) and its multiple-choice options are NOT both clearly visible on the pages, do NOT output a question. Never reconstruct a question from an explanation alone. Never use explanation text as the question or as the options.
- Keep medical spelling exactly as shown unless clearly OCR-corrupted.
 - NEVER write image placeholders, captions, descriptions of images, or filler text like "[Image of...]", "[Blood film showing...]", "[Image showing...]", "(see image below)", "Image:", "Photo:", "[insert image]", or any similar bracketed/parenthetical description of a visible image. If a question or explanation refers to an image, simply omit any mention of the image — do NOT describe it, label it, or insert a placeholder for it. Continue the question text naturally as if the image is not there. Images will be added in a separate import step.
CRITICAL — TABLE FORMATTING (read this carefully):
 
You MUST convert any visually-aligned column data into proper HTML tables.
The PDF often shows data as aligned text that LOOKS like a table but is actually plain text.
You must recognize this pattern and output a real HTML <table>.
 
ALWAYS build a table for any of these patterns:
 
1. Lab results / blood tests / biochemistry. Example pattern in the PDF:
     Sodium      141 mmol/L     (137-144)
     Potassium   4.8 mmol/L     (3.5-4.9)
     Urea        35.2 mmol/L    (2.5-7.5)
     Creatinine  850 μmol/L     (60-110)
   This is a 3-column table: parameter, value, reference range.
 
2. Vital signs listed with values (BP, HR, RR, Temp, SpO2, GCS, etc.).
 
3. Drug regimens where dose and frequency are shown in aligned columns.
 
4. ANY other multi-row, multi-column data that is visually presented as aligned columns in the PDF.
 
Use exactly this HTML format — no <thead>, no <tbody>, no class attributes, no inline CSS, no style attributes:
 
<table><tr><td>Sodium</td><td>141 mmol/L</td><td>(137-144)</td></tr><tr><td>Potassium</td><td>4.8 mmol/L</td><td>(3.5-4.9)</td></tr></table>
 
WRONG (do NOT do this — plain text with line breaks):
"Bloods show:\\nSodium 141 mmol/L (137-144)\\nPotassium 4.8 mmol/L (3.5-4.9)"
 
RIGHT (always do this — real HTML table):
"Bloods show:<br><table><tr><td>Sodium</td><td>141 mmol/L</td><td>(137-144)</td></tr><tr><td>Potassium</td><td>4.8 mmol/L</td><td>(3.5-4.9)</td></tr></table>"
 
Apply table rules to BOTH the "question" field AND the "explanation" field.
 
Plain bullet lists (such as a list of drug names without aligned doses, or a list of key learning points) should remain as <ul><li>...</li></ul> — not as tables.
 
For bold text use <b>...</b>. For line breaks outside tables use <br>.
`;
}
 
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = 240000,
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
 
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
 
function getReadableError(rawText: string) {
  try {
    const parsed = JSON.parse(rawText);
    return (
      parsed?.error?.message ||
      parsed?.message ||
      parsed?.error ||
      rawText
    );
  } catch {
    return rawText;
  }
}
 
function getGeminiApiKeys(): string[] {
  const keys: string[] = [];

  // Easy method:
  // Add many keys in one Supabase secret:
  // GEMINI_API_KEYS=key1,key2,key3,key4
  const combinedKeys = Deno.env.get("GEMINI_API_KEYS");
  if (combinedKeys && combinedKeys.trim()) {
    combinedKeys
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean)
      .forEach((key) => keys.push(key));
  }

  // Normal method:
  // GEMINI_API_KEY
  const primary = Deno.env.get("GEMINI_API_KEY");
  if (primary && primary.trim()) keys.push(primary.trim());

  // Extra numbered keys:
  // GEMINI_API_KEY_2 through GEMINI_API_KEY_50
  for (let i = 2; i <= 50; i++) {
    const key = Deno.env.get(`GEMINI_API_KEY_${i}`);
    if (key && key.trim()) keys.push(key.trim());
  }

  // Remove duplicates in case the same key is added twice
  return [...new Set(keys)];
}
 
function isQuotaErrorMessage(text: string): boolean {
  const lower = String(text || "").toLowerCase();
  return (
    lower.includes("quota") ||
    lower.includes("too many requests") ||
    lower.includes("rate limit") ||
    lower.includes("resource_exhausted")
  );
}
 
async function callGemini(params: {
  pdfBase64: string;
  mimeType: string;
  prompt: string;
}) {
  const apiKeys = getGeminiApiKeys();
 
  if (apiKeys.length === 0) {
    throw new ProviderError("gemini", 401, "Missing GEMINI_API_KEY.");
  }
 
const model = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-pro";
  let lastQuotaError: ProviderError | null = null;
 
  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i];
    const keyLabel = i === 0 ? "GEMINI_API_KEY" : `GEMINI_API_KEY_${i + 1}`;
 
    const response = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  inline_data: {
                    mime_type: params.mimeType,
                    data: params.pdfBase64,
                  },
                },
                {
                  text: params.prompt,
                },
              ],
            },
          ],
        generationConfig: {
            temperature: 0,
            response_mime_type: "application/json",
            maxOutputTokens: 32768,
          },
        }),
          },
      240000,
    );
 
    const rawText = await response.text();
 
    if (!response.ok) {
      const errorMessage = getReadableError(rawText);
 
      // If it's a quota/rate-limit error and we still have more keys, try the next one
      if (
        (response.status === 429 || isQuotaErrorMessage(errorMessage)) &&
        i < apiKeys.length - 1
      ) {
        lastQuotaError = new ProviderError(
          "gemini",
          response.status,
          `[${keyLabel}] ${errorMessage}`,
        );
        continue;
      }
 
      throw new ProviderError(
        "gemini",
        response.status,
        `[${keyLabel}] ${errorMessage}`,
      );
    }
 
    const data = JSON.parse(rawText);
 
    const outputText =
      data?.candidates?.[0]?.content?.parts
        ?.map((part: any) => part.text || "")
        ?.join("") || "";
 
    if (!outputText.trim()) {
      throw new ProviderError(
        "gemini",
        502,
        `[${keyLabel}] Gemini returned an empty response.`,
      );
    }
 
    return {
      provider: "gemini",
      model: apiKeys.length > 1 ? `${model} (${keyLabel})` : model,
      text: outputText,
    };
  }
 
  // All keys exhausted with quota errors
  throw lastQuotaError ||
    new ProviderError("gemini", 429, "All Gemini API keys exhausted by quota.");
}
 
async function callOpenAI(params: {
  pdfBase64: string;
  mimeType: string;
  fileName: string;
  prompt: string;
}) {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
 
  if (!apiKey) {
    throw new ProviderError("openai", 401, "Missing OPENAI_API_KEY.");
  }
 
 const model = Deno.env.get("OPENAI_MODEL") || "gpt-5.5";
 
  const response = await fetchWithTimeout(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_file",
                filename: params.fileName || "uploaded.pdf",
                file_data: `data:${params.mimeType};base64,${params.pdfBase64}`,
              },
              {
                type: "input_text",
                text: params.prompt,
              },
            ],
          },
        ],
       reasoning: {
          effort: "high",
        },
        max_output_tokens: 32768,
      }),
    },
  );
 
  const rawText = await response.text();
 
  if (!response.ok) {
    throw new ProviderError(
      "openai",
      response.status,
      getReadableError(rawText),
    );
  }
 
  const data = JSON.parse(rawText);
 
  let outputText = data?.output_text || "";
 
  if (!outputText && Array.isArray(data?.output)) {
    outputText = data.output
      .flatMap((item: any) => item.content || [])
      .map((content: any) => content.text || "")
      .join("");
  }
 
  if (!outputText.trim()) {
    throw new ProviderError("openai", 502, "OpenAI returned an empty response.");
  }
 
  return {
    provider: "openai",
    model,
    text: outputText,
  };
}
 
async function callClaude(params: {
  pdfBase64: string;
  mimeType: string;
  prompt: string;
}) {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
 
  if (!apiKey) {
    throw new ProviderError("claude", 401, "Missing ANTHROPIC_API_KEY.");
  }
 
 const model = Deno.env.get("ANTHROPIC_MODEL") || "claude-opus-4-7";
 
  const response = await fetchWithTimeout(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
       max_tokens: 32768,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: params.mimeType,
                  data: params.pdfBase64,
                },
              },
              {
                type: "text",
                text: params.prompt,
              },
            ],
          },
        ],
      }),
    },
  );
 
  const rawText = await response.text();
 
  if (!response.ok) {
    throw new ProviderError(
      "claude",
      response.status,
      getReadableError(rawText),
    );
  }
 
  const data = JSON.parse(rawText);
 
  const outputText =
    data?.content
      ?.filter((block: any) => block.type === "text")
      ?.map((block: any) => block.text || "")
      ?.join("") || "";
 
  if (!outputText.trim()) {
    throw new ProviderError("claude", 502, "Claude returned an empty response.");
  }
 
  return {
    provider: "claude",
    model,
    text: outputText,
  };
}
 
async function callOpenRouter(params: {
  pdfBase64: string;
  mimeType: string;
  fileName: string;
  prompt: string;
}) {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
 
  if (!apiKey) {
    throw new ProviderError("openrouter", 401, "Missing OPENROUTER_API_KEY.");
  }
 
  const model =
    Deno.env.get("OPENROUTER_MODEL") || "google/gemini-2.5-pro";
 
  const response = await fetchWithTimeout(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
       temperature: 0,
        max_tokens: 32768,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: params.prompt,
              },
              {
                type: "file",
                file: {
                  filename: params.fileName || "uploaded.pdf",
                  file_data: `data:${params.mimeType};base64,${params.pdfBase64}`,
                },
              },
            ],
          },
        ],
      }),
    },
  );
 
  const rawText = await response.text();
 
  if (!response.ok) {
    throw new ProviderError(
      "openrouter",
      response.status,
      getReadableError(rawText),
    );
  }
 
  const data = JSON.parse(rawText);
  const outputText = data?.choices?.[0]?.message?.content || "";
 
  if (!outputText.trim()) {
    throw new ProviderError(
      "openrouter",
      502,
      "OpenRouter returned an empty response.",
    );
  }
 
  return {
    provider: "openrouter",
    model,
    text: outputText,
  };
}
 
function getProviderOrder(provider: string): ProviderName[] {
  if (provider === "gemini") return ["gemini"];
  if (provider === "openai") return ["openai"];
  if (provider === "claude") return ["claude"];
  if (provider === "openrouter") return ["openrouter"];
 
// High-quality auto fallback order.
// Gemini rotates through all your Gemini Pro keys first.
// Claude Opus is next because it handles PDFs using both extracted text and page images.
// OpenAI GPT-5.5 is next.
// OpenRouter is last and must be configured with a high-quality model.
  return ["gemini", "claude", "openai", "openrouter"];
}
 
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
 
  try {
    if (req.method !== "POST") {
      return jsonResponse({ error: "Only POST requests are allowed." }, 405);
    }
 
    const body = await req.json();
 
    let pdfBase64 = body?.pdfBase64;
    const mimeType = body?.mimeType || "application/pdf";
    const fileName = body?.fileName || "uploaded.pdf";
    const startPage = body?.startPage || null;
    const endPage = body?.endPage || null;
    const requestedProvider = body?.provider || "auto";
 
    if (!pdfBase64 || typeof pdfBase64 !== "string") {
      return jsonResponse({ error: "Missing pdfBase64 in request body." }, 400);
    }
 
    if (pdfBase64.includes(",")) {
      pdfBase64 = pdfBase64.split(",")[1];
    }
 
    const approxBytes = Math.ceil((pdfBase64.length * 3) / 4);
    const approxMb = approxBytes / (1024 * 1024);
 
    if (approxMb > 18) {
      return jsonResponse({
        error: "PDF chunk is too large.",
        details: "Use smaller PDF chunks. Try 1-2 pages for scanned PDFs.",
        approximateSizeMb: approxMb.toFixed(2),
      }, 413);
    }
 
    const prompt = buildPrompt(startPage, endPage);
    const providerOrder = getProviderOrder(requestedProvider);
    const attempts: any[] = [];
 
    for (const provider of providerOrder) {
      try {
        let result;
 
        if (provider === "gemini") {
          result = await callGemini({
            pdfBase64,
            mimeType,
            prompt,
          });
        } else if (provider === "openai") {
          result = await callOpenAI({
            pdfBase64,
            mimeType,
            fileName,
            prompt,
          });
        } else if (provider === "claude") {
          result = await callClaude({
            pdfBase64,
            mimeType,
            prompt,
          });
        } else {
          result = await callOpenRouter({
            pdfBase64,
            mimeType,
            fileName,
            prompt,
          });
        }
 
        const cleanedJson = cleanJsonText(result.text);
 
        return jsonResponse({
          ok: true,
          provider: result.provider,
          model: result.model,
          fileName,
          json: cleanedJson,
          attempts,
        });
 
      } catch (error) {
        const status = error instanceof ProviderError ? error.status : 500;
        const message = error instanceof Error ? error.message : String(error);
 
        attempts.push({
          provider,
          status,
          error: message.slice(0, 2000),
        });
 
        // If user manually selected one provider, do not fallback.
        if (requestedProvider !== "auto") {
          return jsonResponse({
            error: `${provider} failed.`,
            status,
            details: message,
            attempts,
          }, status === 401 ? 500 : status);
        }
 
        // In auto mode, continue to the next provider.
        continue;
      }
    }
 
    const allQuotaErrors = attempts.length > 0 && attempts.every((attempt) =>
      attempt.status === 429 ||
      String(attempt.error || "").toLowerCase().includes("quota") ||
      String(attempt.error || "").toLowerCase().includes("too many requests")
    );
 
    return jsonResponse({
      error: "All AI providers failed.",
      details: "Auto fallback tried all available providers but none succeeded.",
      attempts,
    }, allQuotaErrors ? 429 : 502);
 
  } catch (error) {
    return jsonResponse({
      error: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});