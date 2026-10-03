import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "./config.js";
import type { ExpenseRecord } from "./types.js";

const genAI = new GoogleGenerativeAI(config.geminiApiKey);
const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash",
  generationConfig: { responseMimeType: "application/json" },
});

const SYSTEM_PROMPT = `You extract a single family-finance expense/income record from a short message.
Today's date is {today}.
Reply with strict JSON only, matching this shape:
{"amount": number, "currency": "3-letter code, guess from context, default USD", "category": "short lowercase category like groceries/transport/salary/rent/entertainment/health/other", "description": "short human-readable summary of what it was", "date": "YYYY-MM-DD, resolve relative dates like today/yesterday against today's date"}
Use a negative amount for expenses and a positive amount for income, if the message lets you tell the direction; otherwise assume it's an expense (positive number).
If the message does not describe any financial transaction, reply with exactly: {"error": "not_a_transaction"}`;

export async function parseExpense(text: string): Promise<ExpenseRecord> {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = SYSTEM_PROMPT.replace("{today}", today);

  const result = await model.generateContent([
    { text: prompt },
    { text: `Message: """${text}"""` },
  ]);

  const raw = result.response.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Gemini returned non-JSON output: ${raw}`);
  }

  if (parsed.error === "not_a_transaction") {
    throw new Error("not_a_transaction");
  }

  const { amount, currency, category, description, date } = parsed;
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new Error(`Gemini returned an invalid amount: ${JSON.stringify(parsed)}`);
  }

  return {
    amount,
    currency: typeof currency === "string" && currency ? currency : "USD",
    category: typeof category === "string" && category ? category : "other",
    description: typeof description === "string" ? description : text,
    date: typeof date === "string" && date ? date : today,
  };
}
