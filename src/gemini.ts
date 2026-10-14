import { GoogleGenerativeAI, type Part } from "@google/generative-ai";
import { config } from "./config.js";
import type { ExpenseRecord, TransactionType } from "./types.js";

const CATEGORIES = [
  "Жильё",
  "Продукты",
  "Кафе и рестораны",
  "Транспорт / байк",
  "Связь и интернет",
  "Подписки",
  "Онлайн-шопинг",
  "Здоровье",
  "Одежда",
  "Развлечения",
  "Виза и документы",
  "Подарки",
  "Комиссии",
  "Погашение долга",
  "Прочее",
] as const;
const SOURCES = [
  "Карта RUB",
"Наличные VND",
"Карта VND",
"USDT",
"Копилка: переезд"
] as const;

const genAI = new GoogleGenerativeAI(config.geminiApiKey);
const model = genAI.getGenerativeModel({
  model: "gemini-flash-lite-latest",
  generationConfig: { responseMimeType: "application/json" },
});

function buildSystemPrompt(today: string): string {
  return `You extract family-finance expense/income records from a short message.
A message usually describes one transaction, but may list several (e.g. "50k coffee, 33000 cosmetics and 500k groceries").
Create one record per separate amount. Do NOT split a single amount into several records, even if it covers several items
(e.g. "500 milk and bread" is one record). Context stated once (date, source, currency, income/expense) applies to every record it covers.
Today's date is ${today}.
Reply with strict JSON only, matching this shape:
{
  "records": [
    {
      "type": "Доход" or "Расход", guessed from context (default "Расход" if unclear),
      "source": one of exactly: ${SOURCES.map((c) => `"${c}"`).join(", ")} "Карта VND" by default,
      "amount": a positive number (always positive regardless of type), if number less that 1000 and currency is VND multiply x1000, "k" means x1000,
      "currency": "3-letter code, guessed from context, default ${config.defaultCurrency}",
      "category": one of exactly: ${CATEGORIES.map((c) => `"${c}"`).join(", ")},
      "description": "short human-readable summary of what it was, in Russian",
      "date": "YYYY-MM-DD, resolve relative dates like today/yesterday against today's date"
    }
  ]
}
If the message does not describe any financial transaction, reply with exactly: {"error": "not_a_transaction"}`;
}

async function generateWithRetry(parts: Part[], attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await model.generateContent(parts);
    } catch (err) {
      const status = (err as { status?: number }).status;
      const retriable = status === 503 || status === 429;
      if (!retriable || attempt === attempts) throw err;
      const delayMs = status === 429 ? 20000 : attempt * 3000;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error("unreachable");
}

function normalizeRecord(parsed: Record<string, unknown>, text: string, today: string): ExpenseRecord {
  const { type, source, amount, currency, category, description, date } = parsed;
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new Error(`Gemini returned an invalid amount: ${JSON.stringify(parsed)}`);
  }

  const transactionType: TransactionType = type === "Доход" ? "Доход" : "Расход";

  return {
    type: transactionType,
    source: typeof source === "string" && SOURCES.includes(source as (typeof SOURCES)[number]) ? source : "Карта VND",
    amount: Math.abs(amount),
    currency: typeof currency === "string" && currency ? currency : config.defaultCurrency,
    category: typeof category === "string" && CATEGORIES.includes(category as (typeof CATEGORIES)[number]) ? category : "Прочее",
    description: typeof description === "string" ? description : text,
    date: typeof date === "string" && date ? date : today,
  };
}

// Parses a message into one or more records. Throws "not_a_transaction" if none found.
export async function parseExpenses(text: string): Promise<ExpenseRecord[]> {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = buildSystemPrompt(today);

  const result = await generateWithRetry([
    { text: prompt },
    { text: `Message: """${text}"""` },
  ]);

  const raw = result.response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Gemini returned non-JSON output: ${raw}`);
  }

  if ((parsed as Record<string, unknown>)?.error === "not_a_transaction") {
    throw new Error("not_a_transaction");
  }

  // Accept {"records": [...]}, a bare array, or a bare single record.
  const items: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as Record<string, unknown>)?.records)
      ? ((parsed as Record<string, unknown>).records as unknown[])
      : [parsed];

  if (items.length === 0) {
    throw new Error("not_a_transaction");
  }

  return items.map((item) => normalizeRecord(item as Record<string, unknown>, text, today));
}

const TRANSCRIBE_PROMPT = `Transcribe this voice message verbatim, in the language it is spoken (usually Russian).
Write numbers as digits and keep words like "к", "тысяч", "млн" as spoken.
Reply with strict JSON only: {"transcript": "..."}
If there is no intelligible speech, reply with exactly: {"transcript": ""}`;

// Converts a voice message to text. Throws "no_speech" if nothing intelligible was said.
export async function transcribeVoice(audio: Buffer, mimeType: string): Promise<string> {
  const result = await generateWithRetry([
    { text: TRANSCRIBE_PROMPT },
    { inlineData: { mimeType, data: audio.toString("base64") } },
  ]);

  const raw = result.response.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Gemini returned non-JSON output: ${raw}`);
  }

  const transcript = typeof parsed.transcript === "string" ? parsed.transcript.trim() : "";
  if (!transcript) {
    throw new Error("no_speech");
  }
  return transcript;
}
