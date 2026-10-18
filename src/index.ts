import { randomUUID } from "node:crypto";
import { Bot, InlineKeyboard, type Context } from "grammy";
import { config } from "./config.js";
import { parseExpenses, transcribeVoice } from "./gemini.js";
import { fetchWeekReport, renderWeekReport } from "./report.js";
import { appendExpenseRows } from "./sheets.js";
import type { ExpenseRecord } from "./types.js";

const bot = new Bot(config.telegramBotToken);

// Multi-record messages waiting for the user to press Accept/Cancel.
// In-memory only: a restart/deploy drops them and the buttons report "expired".
// `header` is shown above the result (e.g. the voice transcript), or "".
const pendingBatches = new Map<string, { records: ExpenseRecord[]; header: string }>();

function formatRecord(record: ExpenseRecord): string {
  return `${record.type}, ${record.amount} ${record.currency} — ${record.category} (${record.description}), ${record.source}, ${record.date}`;
}

function formatBatch(records: ExpenseRecord[]): string {
  if (records.length === 1) return formatRecord(records[0]);
  return records.map((record, i) => `${i + 1}. ${formatRecord(record)}`).join("\n");
}

// Stores a batch awaiting confirmation and builds its buttons.
// Multi-record batches also get "Edit", which splits them into one message per record.
function addPendingBatch(records: ExpenseRecord[], header: string): InlineKeyboard {
  const batchId = randomUUID();
  pendingBatches.set(batchId, { records, header });
  const keyboard = new InlineKeyboard()
    .text("✅ Accept", `accept:${batchId}`)
    .text("❌ Cancel", `cancel:${batchId}`);
  if (records.length > 1) keyboard.text("✏️ Edit", `edit:${batchId}`);
  return keyboard;
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

// Parses `text` and either records it (1 record) or asks for confirmation (2+).
// `header` is prepended to every reply, e.g. the transcript of a voice message.
async function handleText(ctx: Context, text: string, header = ""): Promise<void> {
  try {
    const records = await parseExpenses(text);

    if (records.length === 1) {
      await appendExpenseRows(records);
      await ctx.reply(`${header}Записано: ${formatRecord(records[0])}`);
      return;
    }

    await ctx.reply(`${header}Найдено записей: ${records.length}. Записать?\n\n${formatBatch(records)}`, {
      reply_markup: addPendingBatch(records, header),
    });
  } catch (err) {
    if (err instanceof Error && err.message === "not_a_transaction") {
      await ctx.reply(`${header}I couldn't find a transaction in that message. Try something like: "500 groceries".`);
      return;
    }
    console.error("Failed to process message:", err);
    await ctx.reply(`${header}Something went wrong recording that. Please try again.`);
  }
}

const HELP_HTML = `<h3>ℹ️ Как пользоваться ботом</h3>
<p><b>Записать операцию</b> — просто напишите или надиктуйте голосовым сообщением, например: <code>500 продукты</code> или <code>кофе 45к, такси 120к</code>.</p>
<p>Одна запись сохраняется сразу. Если записей несколько, бот покажет их списком с кнопками:</p>
<ul><li>✅ <b>Accept</b> — записать все</li><li>❌ <b>Cancel</b> — ничего не записывать</li><li>✏️ <b>Edit</b> — разбить на отдельные сообщения, чтобы подтвердить каждую запись по отдельности</li></ul>
<h3>Команды</h3>
<p>/report_week — отчёт за текущую неделю: траты по дням, лимит, остаток и перерасход.</p>
<p>/help — эта справка.</p>`;

// Registered before "message:text" so the command isn't parsed as a transaction.
bot.command("report_week", async (ctx) => {
  if (!(await isAuthorized(ctx))) return;
  try {
    await ctx.replyWithRichMessage(renderWeekReport(await fetchWeekReport()));
  } catch (err) {
    console.error("Failed to build week report:", err);
    await ctx.reply("Не удалось построить отчёт за неделю. Попробуйте ещё раз.");
  }
});

bot.command("help", async (ctx) => {
  if (!(await isAuthorized(ctx))) return;
  await ctx.replyWithRichMessage({ html: HELP_HTML, skip_entity_detection: true });
});

bot.on("message:text", async (ctx) => {
  if (!(await isAuthorized(ctx))) return;
  await handleText(ctx, ctx.message.text);
});

bot.on("message:voice", async (ctx) => {
  if (!(await isAuthorized(ctx))) return;

  let transcript: string;
  try {
    const file = await ctx.getFile();
    const res = await fetch(`https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`);
    if (!res.ok) throw new Error(`Voice download failed: HTTP ${res.status}`);
    const audio = Buffer.from(await res.arrayBuffer());
    transcript = await transcribeVoice(audio, ctx.message.voice.mime_type ?? "audio/ogg");
  } catch (err) {
    if (err instanceof Error && err.message === "no_speech") {
      await ctx.reply("I couldn't make out any speech in that voice message. Please try again.");
      return;
    }
    console.error("Failed to transcribe voice message:", err);
    await ctx.reply("Something went wrong transcribing that voice message. Please try again.");
    return;
  }

  await handleText(ctx, transcript, `🎤 «${transcript}»\n\n`);
});

bot.callbackQuery(/^(accept|cancel|edit):(.+)$/, async (ctx) => {
  if (!(await isAuthorized(ctx))) return;

  const [, action, batchId] = ctx.match;
  const batch = pendingBatches.get(batchId);
  // Remove before writing so a double tap can't append the batch twice.
  pendingBatches.delete(batchId);

  if (!batch) {
    await ctx.answerCallbackQuery({ text: "This request has expired. Please send the message again." });
    await ctx.editMessageReplyMarkup();
    return;
  }

  const { records, header } = batch;

  if (action === "edit") {
    await ctx.answerCallbackQuery();
    try {
      await ctx.deleteMessage();
    } catch {
      // Telegram can't delete messages older than 48h — just disable the old buttons.
      await ctx.editMessageText(`${header}Разделено на отдельные записи ниже.`);
    }
    // The transcript (if any) goes on the first record only, to keep the chat readable.
    for (const [i, record] of records.entries()) {
      const recordHeader = i === 0 ? header : "";
      await ctx.reply(`${recordHeader}Запись ${i + 1}/${records.length}. Записать?\n\n${formatRecord(record)}`, {
        reply_markup: addPendingBatch([record], recordHeader),
      });
    }
    return;
  }

  if (action === "cancel") {
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    await ctx.editMessageText(`${header}Отменено, ничего не записано:\n\n${formatBatch(records)}`);
    return;
  }

  try {
    await appendExpenseRows(records);
    await ctx.answerCallbackQuery({ text: "Saved" });
    await ctx.editMessageText(`${header}Записано${records.length > 1 ? ` (${records.length})` : ""}:\n\n${formatBatch(records)}`);
  } catch (err) {
    console.error("Failed to record batch:", err);
    // Put it back so the user can retry with the same buttons.
    pendingBatches.set(batchId, batch);
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
  onStart: (me) => {
    console.log(`Finance bot started as @${me.username}.`);
    bot.api
      .setMyCommands([
        { command: "report_week", description: "Отчёт за неделю" },
        { command: "help", description: "Как пользоваться ботом" },
      ])
      .catch((err) => console.error("Failed to set bot commands:", err));
  },
});
