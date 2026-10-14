import { randomUUID } from "node:crypto";
import { Bot, InlineKeyboard, type Context } from "grammy";
import { config } from "./config.js";
import { parseExpenses } from "./gemini.js";
import { appendExpenseRows } from "./sheets.js";
import type { ExpenseRecord } from "./types.js";

const bot = new Bot(config.telegramBotToken);

// Multi-record messages waiting for the user to press Accept/Cancel.
// In-memory only: a restart/deploy drops them and the buttons report "expired".
const pendingBatches = new Map<string, ExpenseRecord[]>();

function formatRecord(record: ExpenseRecord): string {
  return `${record.type}, ${record.amount} ${record.currency} — ${record.category} (${record.description}), ${record.source}, ${record.date}`;
}

function formatBatch(records: ExpenseRecord[]): string {
  return records.map((record, i) => `${i + 1}. ${formatRecord(record)}`).join("\n");
}

async function isAuthorized(ctx: Context): Promise<boolean> {
  const userId = String(ctx.from?.id);
  if (config.allowedUserIds.has(userId)) return true;
  console.warn(
    `Unauthorized access attempt from user id=${userId} username=@${ctx.from?.username ?? "unknown"}`
  );
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: "You're not authorized to use this bot." });
  } else {
    await ctx.reply("You're not authorized to use this bot.");
  }
  return false;
}

bot.on("message:text", async (ctx) => {
  if (!(await isAuthorized(ctx))) return;

  const text = ctx.message.text;

  try {
    const records = await parseExpenses(text);

    if (records.length === 1) {
      await appendExpenseRows(records);
      await ctx.reply(`Записано: ${formatRecord(records[0])}`);
      return;
    }

    const batchId = randomUUID();
    pendingBatches.set(batchId, records);
    await ctx.reply(`Найдено записей: ${records.length}. Записать?\n\n${formatBatch(records)}`, {
      reply_markup: new InlineKeyboard()
        .text("✅ Accept", `accept:${batchId}`)
        .text("❌ Cancel", `cancel:${batchId}`),
    });
  } catch (err) {
    if (err instanceof Error && err.message === "not_a_transaction") {
      await ctx.reply("I couldn't find a transaction in that message. Try something like: \"500 groceries\".");
      return;
    }
    console.error("Failed to process message:", err);
    await ctx.reply("Something went wrong recording that. Please try again.");
  }
});

bot.callbackQuery(/^(accept|cancel):(.+)$/, async (ctx) => {
  if (!(await isAuthorized(ctx))) return;

  const [, action, batchId] = ctx.match;
  const records = pendingBatches.get(batchId);
  // Remove before writing so a double tap can't append the batch twice.
  pendingBatches.delete(batchId);

  if (!records) {
    await ctx.answerCallbackQuery({ text: "This request has expired. Please send the message again." });
    await ctx.editMessageReplyMarkup();
    return;
  }

  if (action === "cancel") {
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    await ctx.editMessageText(`Отменено, ничего не записано:\n\n${formatBatch(records)}`);
    return;
  }

  try {
    await appendExpenseRows(records);
    await ctx.answerCallbackQuery({ text: "Saved" });
    await ctx.editMessageText(`Записано (${records.length}):\n\n${formatBatch(records)}`);
  } catch (err) {
    console.error("Failed to record batch:", err);
    // Put it back so the user can retry with the same buttons.
    pendingBatches.set(batchId, records);
    await ctx.answerCallbackQuery({ text: "Something went wrong recording that. Please try again." });
  }
});

bot.catch((err) => {
  console.error("Bot error:", err);
});

// Stop long polling cleanly on `docker stop` / deploys, so the next instance
// doesn't hit a 409 conflict on getUpdates.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log(`Received ${signal}, stopping bot...`);
    void bot.stop();
  });
}

bot.start({
  onStart: (me) => console.log(`Finance bot started as @${me.username}.`),
});
