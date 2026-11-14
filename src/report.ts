import type { Context } from "grammy";
import { config } from "./config.js";
import { readRange } from "./sheets.js";

// Layout of the report sheet: rows 6–12 are Mon..Sun, row 13 is the week summary.
// Columns: day label | date | spend | limit | saved | overdraft | status (amounts in VND).
const REPORT_RANGE = "A6:G13";
const DAYS = 7;
// Chart height in rows for the tallest bar; each cell can also be half-filled.
const CHART_ROWS = 8;
const DAY_NAMES = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

type RichMessage = Parameters<Context["replyWithRichMessage"]>[0];

interface DayRow {
  label: string;
  date: Date | string;
  spend: number;
  limit: number;
  overdraft: number;
}

export interface WeekReport {
  days: DayRow[];
  spend: number;
  limit: number;
  saved: number;
  overdraft: number;
  status: string;
}

const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function num(value: unknown): number {
  if (typeof value === "number") return value;
  const parsed = Number(String(value ?? "").replace(/[\s ]/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

// Sheets returns dates as serial numbers (days since 1899-12-30) with SERIAL_NUMBER rendering.
function sheetDate(value: unknown): Date | string {
  if (typeof value === "number") return new Date(Date.UTC(1899, 11, 30) + value * 86_400_000);
  return String(value ?? "");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function money(n: number): string {
  return Math.round(n).toLocaleString("ru-RU");
}

function formatRange(first: Date | string, last: Date | string): string {
  if (typeof first === "string" || typeof last === "string") return `${first}–${last}`;
  const sameMonth = first.getUTCMonth() === last.getUTCMonth();
  const start = sameMonth ? `${first.getUTCDate()}` : `${first.getUTCDate()} ${MONTHS[first.getUTCMonth()]}`;
  return `${start}–${last.getUTCDate()} ${MONTHS[last.getUTCMonth()]}`;
}

// Index of today in the Mon..Sun week, in the family's timezone.
function todayIndex(): number {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: config.reportTimezone }).format(
    new Date()
  );
  return WEEKDAYS.indexOf(weekday);
}

export async function fetchWeekReport(): Promise<WeekReport> {
  const rows = await readRange(`'${config.reportSheetName}'!${REPORT_RANGE}`);
  const days = Array.from({ length: DAYS }, (_, i): DayRow => {
    const [label, date, spend, limit, , overdraft] = rows[i] ?? [];
    return {
      label: String(label ?? ""),
      date: sheetDate(date),
      spend: num(spend),
      limit: num(limit),
      overdraft: num(overdraft),
    };
  });
  const [, , spend, limit, saved, overdraft, status] = rows[DAYS] ?? [];
  return {
    days,
    spend: num(spend),
    limit: num(limit),
    saved: num(saved),
    overdraft: num(overdraft),
    status: String(status ?? ""),
  };
}

// Bar value in thousands, 3–4 chars so the columns stay narrow: 240 · 1,2м
export function barLabel(n: number): string {
  if (n <= 0) return "—";
  const k = Math.round(n / 1000);
  return k < 1000 ? String(k) : `${(n / 1_000_000).toFixed(1).replace(".", ",")}м`;
}

export interface Column {
  value: number;
  limit: number;
  future: boolean;
}

// Vertical bar chart drawn in a monospace <pre> block (rich messages have no colors or images):
// █ spend within the day's limit, ▓ the part over it, ░ recommended spend for days ahead,
// ┄ the daily limit (only when every day has the same one), ▲ under today.
// The first line is the unit caption: Telegram strips leading whitespace from a <pre> block, so a
// first line starting with spaces (a short Monday bar) would shift that whole row to the left.
export function renderChart(columns: Column[], today: number): string {
  const labels = columns.map((c) => barLabel(c.value));
  const width = Math.max(3, ...labels.map((l) => l.length));
  const step = Math.max(1, ...columns.map((c) => Math.max(c.value, c.limit))) / CHART_ROWS;
  // Bar heights in half-rows; any spend shows at least half a cell. Future bars snap to whole rows,
  // as ░ has no half-cell variant (a half drawn as ░ would look a whole cell tall).
  const heights = columns.map((c) => {
    if (c.value <= 0) return 0;
    return c.future ? Math.max(2, Math.round(c.value / step) * 2) : Math.max(1, Math.round((c.value / step) * 2));
  });
  const limitRows = columns.map((c) => Math.round(c.limit / step));
  const sharedLimit = new Set(columns.map((c) => c.limit)).size === 1 && columns[0].limit > 0;
  const topRow = Math.max(...heights.map((h) => Math.ceil(h / 2))) + 1; // +1 for the value labels
  // Bars crossing the line keep their own fill, so the line reads as passing behind them.
  const limitLine = (row: number): string => {
    const line = columns.map((c, i) => (heights[i] > row * 2 - 2 ? (c.future ? "░" : "█").repeat(width) : "┄".repeat(width)));
    return `${line.join("┄")} ${barLabel(columns[0].limit)}`;
  };

  const cell = (i: number, row: number): string => {
    const { future } = columns[i];
    const h = heights[i];
    const over = row > limitRows[i];
    if (h >= row * 2) return (future ? "░" : over ? "▓" : "█").repeat(width);
    if (h === row * 2 - 1) return "▄".repeat(width);
    if (Math.ceil(h / 2) === row - 1) return labels[i].padStart(width);
    return " ".repeat(width);
  };

  const lines = ["тыс. ₫"];
  // A limit above every bar (and its label) still gets drawn, on top.
  if (sharedLimit && limitRows[0] >= topRow) lines.push(limitLine(limitRows[0] + 1));
  for (let row = topRow; row >= 1; row--) {
    lines.push(columns.map((_, i) => cell(i, row)).join(" ").trimEnd());
    if (sharedLimit && row - 1 === limitRows[0]) lines.push(limitLine(row));
  }
  lines.push(DAY_NAMES.map((d) => d.padEnd(width)).join(" ").trimEnd());
  if (today >= 0) lines.push(`${" ".repeat((width + 1) * today)}▲`);
  return lines.join("\n");
}

export function renderWeekReport(report: WeekReport, today = todayIndex()): RichMessage {
  // Includes today.
  const daysLeft = DAYS - Math.max(today, 0);
  const remaining = report.limit - report.spend;
  // Today's unspent limit is taken out first; the rest is split over daysLeft.
  // An overspent today reserves nothing (the overspend is already out of `remaining`).
  const todayLeft = today >= 0 ? Math.max(0, report.days[today].limit - report.days[today].spend) : 0;
  const leftForFuture = remaining - todayLeft;
  const perDayLeft = daysLeft > 0 && leftForFuture > 0 ? leftForFuture / daysLeft : 0;

  const columns = report.days.map((day, i): Column => {
    const future = i > today && day.spend === 0;
    return { value: future ? perDayLeft : day.spend, limit: day.limit, future };
  });

  const dailyLimits = new Set(report.days.map((d) => d.limit));
  const limitNote =
    dailyLimits.size === 1
      ? `лимит <b>${money(report.days[0].limit)} ₫</b> в день`
      : `лимит <b>${money(report.limit)} ₫</b> на неделю`;
  const pct = report.limit > 0 ? Math.round((report.spend / report.limit) * 100) : 0;
  const overspent = report.days.flatMap((d, i) => (d.overdraft > 0 ? [i] : []));
  const overspentTotal = overspent.reduce((sum, i) => sum + report.days[i].overdraft, 0);

  const summary: string[] = [];
  if (today >= 0) {
    const day = report.days[today];
    const availableToday = day.limit - day.spend;
    summary.push(
      availableToday >= 0
        ? `<p>💵 <b>Доступно сегодня: ${money(availableToday)} ₫</b> из ${money(day.limit)} ₫</p>`
        : `<p>🟧 <b>Сегодня перерасход: ${money(-availableToday)} ₫</b> (лимит ${money(day.limit)} ₫)</p>`
    );
  }
  summary.push(
    `<p>Потрачено <b>${money(report.spend)}</b> из ${money(report.limit)} ₫ · ${pct}%</p>`,
    remaining >= 0
      ? `<p>Осталось ${money(remaining)} ₫${perDayLeft > 0 ? ` · ≈ ${money(perDayLeft)} ₫ в день` : ""}</p>`
      : `<p>🟧 <b>Перерасход недели: ${money(report.overdraft || -remaining)} ₫</b></p>`
  );
  if (overspent.length > 0) {
    const days = overspent.map((i) => DAY_NAMES[i]).join(", ");
    summary.push(`<p>🟧 <b>Перерасход: ${days}</b> (+${money(overspentTotal)} ₫)</p>`);
  }
  if (report.saved > 0) summary.push(`<p>💰 Сэкономлено ${money(report.saved)} ₫</p>`);
  if (report.status) summary.push(`<p>Статус: <b>${escapeHtml(report.status)}</b></p>`);

  const html = [
    `<h3>📊 Бюджет · Неделя</h3>`,
    `<p>${formatRange(report.days[0].date, report.days[DAYS - 1].date)} · ${limitNote}</p>`,
    `<pre>${renderChart(columns, today)}</pre>`,
    ...summary,
    `<footer>█ в лимите · ▓ перерасход · ░ рекомендуется · ▲ сегодня</footer>`,
  ].join("\n");

  return { html, skip_entity_detection: true };
}
