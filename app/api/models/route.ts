const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

type OpenRouterModel = {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  pricing?: {
    prompt?: unknown;
    completion?: unknown;
  };
  architecture?: {
    input_modalities?: unknown;
    output_modalities?: unknown;
  };
};

type ModelOption = {
  id: string;
  name: string;
  shortName: string;
  contextLength: number;
  promptPrice: string;
  completionPrice: string;
};

const getShortName = (name: string, id: string) => {
  const source = name.trim() || id.split("/").at(-1) || id;
  const words = source.replace(/[^a-zA-Z0-9 ]/g, " ").trim().split(/\s+/);
  return words.slice(0, 3).map((word) => word[0]).join("").toUpperCase() || "AI";
};

export async function GET() {
  try {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      headers: {
        "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
        "X-Title": "LLM Arena",
      },
      next: { revalidate: 300 },
    });

    if (!response.ok) {
      return Response.json({ error: "The model catalog is temporarily unavailable." }, { status: 502 });
    }

    const payload = (await response.json()) as { data?: OpenRouterModel[] };
    const models: ModelOption[] = (payload.data ?? [])
      .filter((model): model is OpenRouterModel & { id: string; name: string } => {
        const modalities = model.architecture?.input_modalities;
        return typeof model.id === "string" && model.id.endsWith(":free") && typeof model.name === "string" && Array.isArray(modalities) && modalities.includes("text");
      })
      .map((model) => ({
        id: model.id,
        name: model.name,
        shortName: getShortName(model.name, model.id),
        contextLength: typeof model.context_length === "number" ? model.context_length : 0,
        promptPrice: typeof model.pricing?.prompt === "string" ? model.pricing.prompt : "0",
        completionPrice: typeof model.pricing?.completion === "string" ? model.pricing.completion : "0",
      }))
      .sort((first, second) => second.contextLength - first.contextLength);

    return Response.json({ models }, { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } });
  } catch {
    return Response.json({ error: "The model catalog is temporarily unavailable." }, { status: 502 });
  }
}
