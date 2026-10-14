import { Bot } from "grammy";
import { config } from "./config.js";
import { parseExpense } from "./gemini.js";
import { appendExpenseRow } from "./sheets.js";

const bot = new Bot(config.telegramBotToken);

bot.on("message:text", async (ctx) => {
  const userId = String(ctx.from.id);

  if (!config.allowedUserIds.has(userId)) {
    console.warn(
      `Unauthorized access attempt from user id=${userId} username=@${ctx.from.username ?? "unknown"}`
    );
    await ctx.reply("You're not authorized to use this bot.");
    return;
  }

  const text = ctx.message.text;

  try {
    const record = await parseExpense(text);
    await appendExpenseRow(record);
    await ctx.reply(
      `Записано: ${record.type}, ${record.amount} ${record.currency} — ${record.category} (${record.description}), ${record.source}, ${record.date}`
    );
  } catch (err) {
    if (err instanceof Error && err.message === "not_a_transaction") {
      await ctx.reply("I couldn't find a transaction in that message. Try something like: \"500 groceries\".");
      return;
    }
    console.error("Failed to process message:", err);
    await ctx.reply("Something went wrong recording that. Please try again.");
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
