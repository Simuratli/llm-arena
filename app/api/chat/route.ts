import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import arcjet, {
  detectBot,
  detectPromptInjection,
  shield,
  tokenBucket,
} from "@arcjet/next";
import { captureServerEvent } from "@/lib/posthog";
import { prisma } from "@/lib/prisma";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const security = process.env.ARCJET_KEY
  ? arcjet({
      key: process.env.ARCJET_KEY,
      characteristics: ["userId"],
      rules: [
        shield({ mode: "LIVE" }),
        detectBot({ mode: "LIVE", allow: [] }),
        tokenBucket({ mode: "LIVE", refillRate: 2, interval: "1h", capacity: 10 }),
        detectPromptInjection({ mode: "LIVE" }),
      ],
    })
  : null;

type ChatRequest = {
  prompt?: unknown;
  models?: unknown;
};

type OpenRouterChunk = {
  choices?: Array<{
    delta?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

type StreamEvent = {
  modelId: string;
  roundId?: string;
  type: "start" | "token" | "complete" | "error";
  text?: string;
  metrics?: {
    timeToFirstTokenMs?: number;
    elapsedMs?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  error?: string;
};

const DEFAULT_MODELS = [
  "liquid/lfm-2.5-2.6b:free",
  "nvidia/nemotron-3.5-lightning:free",
  "cohere/north-mini-code:free",
];

const sendEvent = (controller: ReadableStreamDefaultController<Uint8Array>, event: StreamEvent) => {
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
};

export async function POST(request: NextRequest) {
  const { userId } = await auth();

  if (!userId) {
    return Response.json({ error: "Please sign in to send a prompt." }, { status: 401 });
  }

  if (!security) {
    return Response.json(
      { error: "Security protection is not configured yet." },
      { status: 503 },
    );
  }

  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    return Response.json(
      { error: "The model connection is not configured yet." },
      { status: 503 },
    );
  }

  if (!process.env.DATABASE_URL) {
    return Response.json(
      { error: "Database storage is not configured yet." },
      { status: 503 },
    );
  }

  let body: ChatRequest;

  try {
    body = (await request.json()) as ChatRequest;
  } catch {
    return Response.json({ error: "Please send a valid request." }, { status: 400 });
  }

  if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
    return Response.json(
      { error: "Write a prompt to continue." },
      { status: 400 },
    );
  }

  const prompt = body.prompt.trim();
  const models = Array.isArray(body.models) && body.models.every((model): model is string => typeof model === "string")
    ? body.models.filter((model, index, selected) => model.endsWith(":free") && selected.indexOf(model) === index).slice(0, 3)
    : DEFAULT_MODELS;

  if (models.length === 0) {
    return Response.json({ error: "Select at least one model." }, { status: 400 });
  }

  const decision = await security.protect(request, {
    userId,
    requested: Math.max(1, Math.ceil((prompt.length * models.length) / 4)),
    detectPromptInjectionMessage: prompt,
  });

  if (decision.isDenied()) {
    if (decision.reason.isRateLimit()) {
      return Response.json({ error: "You have reached the usage limit. Please try again later." }, { status: 429 });
    }

    if (decision.reason.isPromptInjection()) {
      return Response.json({ error: "This prompt was blocked by security checks. Please rephrase it." }, { status: 400 });
    }

    return Response.json({ error: "This request did not pass security checks." }, { status: 403 });
  }

  await captureServerEvent({ distinctId: userId, event: "prompt_sent", properties: { model_count: models.length } });

  let round: { id: string };

  try {
    const user = await prisma.user.upsert({
      where: { clerkId: userId },
      update: {},
      create: { clerkId: userId },
    });
    round = await prisma.round.create({ data: { userId: user.id, prompt } });
  } catch {
    return Response.json(
      { error: "Database is unavailable. Start PostgreSQL or check DATABASE_URL." },
      { status: 503 },
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      await Promise.all(models.map(async (modelId) => {
        const startedAt = Date.now();
        let firstTokenAt: number | undefined;
        let upstream: Response;
        let answer = "";

        sendEvent(controller, { modelId, roundId: round.id, type: "start" });

        try {
          upstream = await fetch(OPENROUTER_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
              "X-Title": "LLM Arena",
            },
            body: JSON.stringify({
              model: modelId,
              messages: [{ role: "user", content: prompt }],
              stream: true,
              stream_options: { include_usage: true },
            }),
          });

          if (!upstream.ok || !upstream.body) {
            throw new Error("The model did not respond.");
          }

          const reader = upstream.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let usage: OpenRouterChunk["usage"];

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6).trim();
              if (data === "[DONE]") continue;

              try {
                const chunk = JSON.parse(data) as OpenRouterChunk;
                usage = chunk.usage ?? usage;
                const text = chunk.choices?.[0]?.delta?.content;
                if (text) {
                  firstTokenAt ??= Date.now();
                  answer += text;
                  sendEvent(controller, { modelId, type: "token", text });
                }
              } catch {
                continue;
              }
            }
          }

          const elapsedMs = Date.now() - startedAt;
          const completionTokens = usage?.completion_tokens ?? 0;
          const timeToFirstTokenMs = firstTokenAt ? firstTokenAt - startedAt : undefined;
          const tokensPerSecond = completionTokens > 0 && elapsedMs > 0
            ? completionTokens / (elapsedMs / 1000)
            : undefined;
          await prisma.modelResponse.create({
            data: {
              roundId: round.id,
              modelId,
              answer,
              status: "complete",
              timeToFirstTokenMs,
              elapsedMs,
              promptTokens: usage?.prompt_tokens,
              completionTokens,
              totalTokens: usage?.total_tokens,
              tokensPerSecond,
            },
          });
          await captureServerEvent({ distinctId: userId, event: "model_completed", properties: { model: modelId, elapsed_ms: elapsedMs, total_tokens: usage?.total_tokens ?? 0 } });
          sendEvent(controller, {
            modelId,
            type: "complete",
            metrics: {
              timeToFirstTokenMs,
              elapsedMs,
              promptTokens: usage?.prompt_tokens,
              completionTokens,
              totalTokens: usage?.total_tokens,
            },
          });
        } catch {
          await prisma.modelResponse.create({
            data: { roundId: round.id, modelId, answer, status: "error" },
          });
          await captureServerEvent({ distinctId: userId, event: "model_failed", properties: { model: modelId } });
          sendEvent(controller, { modelId, type: "error", error: "This model is not responding right now." });
        }
      }));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
