import { randomUUID } from "node:crypto";
import { Bot, InlineKeyboard, type Context } from "grammy";
import { createInvite, inviteTtlHours, isAllowed, isOwner, listInvitedUsers, redeemInvite, removeInvitedUser } from "./access.js";
import { formatEntry, isAnnounced, latestEntry, markAnnounced } from "./changelog.js";
import { config } from "./config.js";
import { parseExpenses, transcribeVoice } from "./gemini.js";
import { fetchWeekReport, renderWeekReport } from "./report.js";
import { appendExpenseRows, deleteLastExpenseRow } from "./sheets.js";
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
  if (isAllowed(userId)) return true;
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
<p>/report_week — отчёт за текущую неделю: траты по дням, сколько доступно сегодня, лимит, остаток и перерасход.</p>
<p>/delete_last — удалить последнюю запись из таблицы.</p>
<p>/change_log — что изменилось в последнем обновлении.</p>
<p>/help — эта справка.</p>`;

const OWNER_HELP_HTML = `<h3>👥 Доступ (только для владельца)</h3>
<p>/invite — одноразовая ссылка-приглашение, действует ${inviteTtlHours} ч.</p>
<p>/users — кто добавлен по приглашению, с кнопкой удаления.</p>`;

function displayName(ctx: Context): string {
  const from = ctx.from;
  if (!from) return "unknown";
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
  return from.username ? `${name} (@${from.username})` : name;
}

function usersKeyboard(): InlineKeyboard | undefined {
  const users = listInvitedUsers();
  if (users.length === 0) return undefined;
  const keyboard = new InlineKeyboard();
  for (const user of users) keyboard.text(`❌ ${user.name}`, `remove_user:${user.id}`).row();
  return keyboard;
}

function usersText(): string {
  const users = listInvitedUsers();
  if (users.length === 0) return "Приглашённых пользователей нет. Владельцы задаются в ALLOWED_USER_IDS.";
  const lines = users.map((user) => `• ${user.name} — id ${user.id}, добавлен ${user.addedAt.slice(0, 10)}`);
  return `Приглашённые пользователи (нажмите, чтобы удалить):\n\n${lines.join("\n")}`;
}

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

bot.command("delete_last", async (ctx) => {
  if (!(await isAuthorized(ctx))) return;
  try {
    const row = await deleteLastExpenseRow();
    if (!row) {
      await ctx.reply("В таблице финансов нет записей для удаления.");
      return;
    }
    const [date, type, source, amount, currency, category, description] = row.values;
    // The sheet's number format renders amounts with a trailing comma ("220 000,").
    const record = `${type}, ${amount.replace(/,$/, "")} ${currency} — ${category} (${description}), ${source}, ${date}`;
    console.log(`Row ${row.rowNumber} removed by id=${ctx.from?.id}: ${record}`);
    await ctx.reply(`Запись ${record} удалена из таблицы финансов`);
  } catch (err) {
    console.error("Failed to delete last record:", err);
    await ctx.reply("Не удалось удалить последнюю запись. Попробуйте ещё раз.");
  }
});

bot.command("change_log", async (ctx) => {
  if (!(await isAuthorized(ctx))) return;
  await ctx.reply(formatEntry(latestEntry()));
});

bot.command("help", async (ctx) => {
  if (!(await isAuthorized(ctx))) return;
  const html = isOwner(String(ctx.from?.id)) ? HELP_HTML + OWNER_HELP_HTML : HELP_HTML;
  await ctx.replyWithRichMessage({ html, skip_entity_detection: true });
});

// Opened via an invite link: t.me/<bot>?start=<token>.
bot.command("start", async (ctx) => {
  const userId = String(ctx.from?.id);
  const token = ctx.match.trim();

  if (token && !isAllowed(userId)) {
    const name = displayName(ctx);
    const inviterId = redeemInvite(token, userId, name);
    if (!inviterId) {
      console.warn(`Invalid or expired invite used by user id=${userId} name=${name}`);
      await ctx.reply("Это приглашение недействительно или истекло. Попросите новую ссылку.");
      return;
    }
    console.log(`User id=${userId} name=${name} joined via invite from id=${inviterId}`);
    await ctx.reply("Добро пожаловать! Доступ открыт.");
    await ctx.replyWithRichMessage({ html: HELP_HTML, skip_entity_detection: true });
    await bot.api
      .sendMessage(inviterId, `✅ ${name} принял(а) приглашение и теперь может пользоваться ботом.`)
      .catch((err) => console.error("Failed to notify inviter:", err));
    return;
  }

  if (!(await isAuthorized(ctx))) return;
  await ctx.replyWithRichMessage({ html: HELP_HTML, skip_entity_detection: true });
});

bot.command("invite", async (ctx) => {
  if (!(await isAuthorized(ctx))) return;
  if (!isOwner(String(ctx.from?.id))) {
    await ctx.reply("Приглашать могут только владельцы бота.");
    return;
  }
  const link = `https://t.me/${ctx.me.username}?start=${createInvite(String(ctx.from?.id))}`;
  await ctx.reply(
    `Отправьте эту ссылку человеку, которого хотите добавить:\n\n${link}\n\n` +
      `Ссылка одноразовая и действует ${inviteTtlHours} ч. Вы получите сообщение, когда её откроют.`,
    { link_preview_options: { is_disabled: true } }
  );
});

bot.command("users", async (ctx) => {
  if (!(await isAuthorized(ctx))) return;
  if (!isOwner(String(ctx.from?.id))) {
    await ctx.reply("Список пользователей доступен только владельцам бота.");
    return;
  }
  await ctx.reply(usersText(), { reply_markup: usersKeyboard() });
});

bot.callbackQuery(/^remove_user:(.+)$/, async (ctx) => {
  if (!(await isAuthorized(ctx))) return;
  if (!isOwner(String(ctx.from.id))) {
    await ctx.answerCallbackQuery({ text: "Только для владельцев." });
    return;
  }
  const removed = removeInvitedUser(ctx.match[1]);
  if (removed) console.log(`User id=${removed.id} name=${removed.name} removed by id=${ctx.from.id}`);
  await ctx.answerCallbackQuery({ text: removed ? `Удалён: ${removed.name}` : "Уже удалён" });
  // Skip the edit when nothing changed — Telegram rejects "message is not modified".
  if (removed) await ctx.editMessageText(usersText(), { reply_markup: usersKeyboard() });
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

const COMMANDS = [
  { command: "report_week", description: "Отчёт за неделю" },
  { command: "delete_last", description: "Удалить последнюю запись" },
  { command: "change_log", description: "Что нового в обновлении" },
  { command: "help", description: "Как пользоваться ботом" },
];

const OWNER_COMMANDS = [
  ...COMMANDS,
  { command: "invite", description: "Пригласить пользователя" },
  { command: "users", description: "Приглашённые пользователи" },
];

// Sends the newest changelog entry to every user once, the first time a deploy containing it starts.
// Silent (no sound/vibration), since it's informational. Marked as sent even if some users can't be
// reached (e.g. they blocked the bot), so a restart doesn't re-notify everyone else.
async function announceUpdate(): Promise<void> {
  const entry = latestEntry();
  if (isAnnounced(entry.id)) return;
  const userIds = new Set([...config.allowedUserIds, ...listInvitedUsers().map((user) => user.id)]);
  const text = formatEntry(entry);
  for (const userId of userIds) {
    await bot.api
      .sendMessage(userId, text, { disable_notification: true })
      .catch((err) => console.error(`Failed to send update notes to ${userId}:`, err));
  }
  markAnnounced(entry.id);
  console.log(`Announced update ${entry.id} to ${userIds.size} user(s).`);
}

bot.start({
  onStart: (me) => {
    console.log(`Finance bot started as @${me.username}.`);
    bot.api.setMyCommands(COMMANDS).catch((err) => console.error("Failed to set bot commands:", err));
    // Owners also see the access-management commands in their menu.
    for (const ownerId of config.allowedUserIds) {
      bot.api
        .setMyCommands(OWNER_COMMANDS, { scope: { type: "chat", chat_id: Number(ownerId) } })
        .catch((err) => console.error(`Failed to set owner commands for ${ownerId}:`, err));
    }
    // Only the deployed container (NODE_ENV=production, set in the Dockerfile) announces — a local `npm run dev`
    // has its own data dir and would otherwise message real users.
    if (process.env.NODE_ENV === "production") announceUpdate().catch((err) => console.error("Failed to announce update:", err));
  },
});
