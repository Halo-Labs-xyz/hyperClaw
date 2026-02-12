import axios from "axios";

type ChatProvider = "gemini" | "nvidia";

interface ChatRoute {
  provider: ChatProvider;
  model: string;
}

interface ChatRequest {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

let providerStartOffset = 0;

function getGeminiApiKey(): string | null {
  const key = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
  return key || null;
}

function getNvidiaApiKey(): string | null {
  const key = (process.env.NVIDIA_API_KEY || "").trim();
  return key || null;
}

function getGeminiModels(): string[] {
  const raw =
    process.env.GEMINI_CHAT_MODELS ||
    process.env.GEMINI_MODELS ||
    process.env.GEMINI_MODEL ||
    "gemini-2.5-flash,gemini-3-flash-preview";
  return raw
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

function getNvidiaModels(): string[] {
  const raw =
    process.env.NVIDIA_CHAT_MODELS ||
    process.env.NVIDIA_MODELS ||
    process.env.NVIDIA_MODEL ||
    "moonshotai/kimi-k2.5";
  return raw
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

function getBalancedRoutes(): ChatRoute[] {
  const gemini = [...getGeminiModels()];
  const nvidia = [...getNvidiaModels()];
  const routes: ChatRoute[] = [];
  let takeGemini = providerStartOffset % 2 === 0;
  providerStartOffset += 1;

  while (gemini.length > 0 || nvidia.length > 0) {
    if (takeGemini && gemini.length > 0) {
      routes.push({ provider: "gemini", model: gemini.shift()! });
    } else if (!takeGemini && nvidia.length > 0) {
      routes.push({ provider: "nvidia", model: nvidia.shift()! });
    } else if (gemini.length > 0) {
      routes.push({ provider: "gemini", model: gemini.shift()! });
    } else if (nvidia.length > 0) {
      routes.push({ provider: "nvidia", model: nvidia.shift()! });
    }
    takeGemini = !takeGemini;
  }
  return routes;
}

async function callGeminiChat(
  model: string,
  req: ChatRequest
): Promise<string> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error("Gemini API key missing");
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: req.systemPrompt }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: req.userPrompt }],
        },
      ],
      generationConfig: {
        temperature: req.temperature ?? 0.5,
        maxOutputTokens: req.maxTokens ?? 300,
      },
    }),
  });

  const data = (await response.json().catch(() => ({}))) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(data.error?.message || `Gemini HTTP ${response.status}`);
  }
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
  if (!text) throw new Error(`Gemini empty response for model ${model}`);
  return text;
}

async function callNvidiaChat(
  model: string,
  req: ChatRequest
): Promise<string> {
  const apiKey = getNvidiaApiKey();
  if (!apiKey) throw new Error("NVIDIA API key missing");
  const endpoint = process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1/chat/completions";

  const response = await axios.post<{
    choices?: Array<{ message?: { content?: string } }>;
  }>(
    endpoint,
    {
      model,
      messages: [
        { role: "system", content: req.systemPrompt },
        { role: "user", content: req.userPrompt },
      ],
      max_tokens: req.maxTokens ?? 300,
      temperature: req.temperature ?? 0.5,
      top_p: 1,
      stream: false,
      chat_template_kwargs: { thinking: true },
    },
    {
      timeout: 15000,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    }
  );

  const text = (response.data.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error(`NVIDIA empty response for model ${model}`);
  return text;
}

export async function generateBalancedChatResponse(req: ChatRequest): Promise<string> {
  const hasGemini = Boolean(getGeminiApiKey());
  const hasNvidia = Boolean(getNvidiaApiKey());
  if (!hasGemini && !hasNvidia) {
    throw new Error("No chat provider API key configured");
  }

  const routes = getBalancedRoutes();
  let lastError: unknown = null;

  for (const route of routes) {
    if (route.provider === "gemini" && !hasGemini) continue;
    if (route.provider === "nvidia" && !hasNvidia) continue;
    try {
      if (route.provider === "gemini") {
        const text = await callGeminiChat(route.model, req);
        console.log(`[AI] Chat model: gemini:${route.model}`);
        return text;
      }
      const text = await callNvidiaChat(route.model, req);
      console.log(`[AI] Chat model: nvidia:${route.model}`);
      return text;
    } catch (error) {
      lastError = error;
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[AI] chat ${route.provider}:${route.model} failed: ${msg.slice(0, 160)}`);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Chat model chain exhausted");
}
