import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

type ProviderName = "gemini" | "openai" | "claude";

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
- Preserve tables as clean HTML tables.
- Keep medical spelling exactly as shown unless clearly OCR-corrupted.
`;
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = 90000,
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

async function callGemini(params: {
  pdfBase64: string;
  mimeType: string;
  prompt: string;
}) {
  const apiKey = Deno.env.get("GEMINI_API_KEY");

  if (!apiKey) {
    throw new ProviderError("gemini", 401, "Missing GEMINI_API_KEY.");
  }

  const model = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash-lite";

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
          temperature: 0.1,
          response_mime_type: "application/json",
        },
      }),
    },
  );

  const rawText = await response.text();

  if (!response.ok) {
    throw new ProviderError(
      "gemini",
      response.status,
      getReadableError(rawText),
    );
  }

  const data = JSON.parse(rawText);

  const outputText =
    data?.candidates?.[0]?.content?.parts
      ?.map((part: any) => part.text || "")
      ?.join("") || "";

  if (!outputText.trim()) {
    throw new ProviderError("gemini", 502, "Gemini returned an empty response.");
  }

  return {
    provider: "gemini",
    model,
    text: outputText,
  };
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

  const model = Deno.env.get("OPENAI_MODEL") || "gpt-4.1-mini";

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
        temperature: 0.1,
        max_output_tokens: 12000,
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

  const model = Deno.env.get("ANTHROPIC_MODEL") || "claude-haiku-4-5";

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
        max_tokens: 12000,
        temperature: 0.1,
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

function getProviderOrder(provider: string): ProviderName[] {
  if (provider === "gemini") return ["gemini"];
  if (provider === "openai") return ["openai"];
  if (provider === "claude") return ["claude"];

  // Auto fallback order
  return ["gemini", "openai", "claude"];
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
        } else {
          result = await callClaude({
            pdfBase64,
            mimeType,
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