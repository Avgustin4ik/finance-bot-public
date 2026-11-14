// Offline check of /report_week rendering (no Telegram, no sheet): renders the report for a set of
// spend patterns plus random weeks and verifies the chart grid stays aligned — every column keeps
// its position on every row, bars are contiguous with their value label on top, the limit line and
// ▲ are where they belong, and the first line of the <pre> never starts with whitespace (Telegram
// strips it, which shifts that whole row left). Also checks the "≈ … ₫ в день" math.
//
// Run with: npm run test:report

// report.ts imports config, which requires these; rendering never uses them.
for (const name of ["TELEGRAM_BOT_TOKEN", "GEMINI_API_KEY", "GOOGLE_SERVICE_ACCOUNT_KEY_FILE", "SPREADSHEET_ID"]) {
  process.env[name] ??= "test";
}
const { renderWeekReport, barLabel } = await import("../src/report.js");
type WeekReport = import("../src/report.js").WeekReport;

const DAY_NAMES = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

function week(spends: number[], limits: number | number[]): WeekReport {
  const dayLimits = typeof limits === "number" ? spends.map(() => limits) : limits;
  const days = spends.map((spend, i) => ({
    label: DAY_NAMES[i],
    date: new Date(Date.UTC(2026, 10, 2 + i)),
    spend,
    limit: dayLimits[i],
    overdraft: Math.max(0, spend - dayLimits[i]),
  }));
  const spend = spends.reduce((a, b) => a + b, 0);
  const limit = dayLimits.reduce((a, b) => a + b, 0);
  return { days, spend, limit, saved: 0, overdraft: Math.max(0, spend - limit), status: "" };
}

// Expected per-day amount: what's left of the week minus today's unspent limit, over today and the days after it.
function expectedPerDay(report: WeekReport, today: number): number {
  const daysLeft = 7 - Math.max(today, 0);
  const todayLeft = today >= 0 ? Math.max(0, report.days[today].limit - report.days[today].spend) : 0;
  const left = report.limit - report.spend - todayLeft;
  return daysLeft > 0 && left > 0 ? left / daysLeft : 0;
}

const FILL = /^(█+|▓+|░+|▄+)$/;

// Returns the problems found; empty when the chart is fine.
function check(report: WeekReport, today: number): string[] {
  const problems: string[] = [];
  const html = renderWeekReport(report, today).html;
  const pre = html.match(/<pre>([\s\S]*)<\/pre>/)?.[1];
  if (pre === undefined) return ["no <pre> block"];
  if (/^\s/.test(pre)) problems.push("<pre> starts with whitespace — Telegram will shift the first row");

  const lines = pre.split("\n");
  const dayLine = lines.findIndex((l) => l.startsWith("Пн"));
  if (dayLine < 0) return [...problems, "no day-name line"];
  const width = lines[dayLine].indexOf("Вт") - 1;
  const step = width + 1;
  const gridWidth = 7 * width + 6;
  const expectedDays = DAY_NAMES.map((d) => d.padEnd(width)).join(" ").trimEnd();
  if (lines[dayLine] !== expectedDays) problems.push(`day line misaligned: "${lines[dayLine]}"`);

  const perDay = expectedPerDay(report, today);
  const values = report.days.map((d, i) => (i > today && d.spend === 0 ? perDay : d.spend));
  const expectedWidth = Math.max(3, ...values.map((v) => barLabel(v).length));
  if (width !== expectedWidth) problems.push(`column width ${width}, expected ${expectedWidth}`);

  // Limit line: exactly one when every day shares a positive limit.
  const limits = new Set(report.days.map((d) => d.limit));
  const sharedLimit = limits.size === 1 && report.days[0].limit > 0;
  const limitLines = lines.slice(1, dayLine).filter((l) => l.includes("┄"));
  if (sharedLimit) {
    const suffix = ` ${barLabel(report.days[0].limit)}`;
    if (limitLines.length !== 1) problems.push(`expected 1 limit line, got ${limitLines.length}`);
    else if (!limitLines[0].endsWith(suffix) || limitLines[0].length !== gridWidth + suffix.length)
      problems.push(`limit line misaligned: "${limitLines[0]}"`);
  } else if (limitLines.length > 0) problems.push("limit line drawn without a shared limit");

  // Bar rows: separators stay blank and each column reads, bottom-up: fill, value label, blanks.
  const rows = lines.slice(1, dayLine).filter((l) => !l.includes("┄"));
  const heights: number[] = [];
  for (const row of rows) {
    if (row.length > gridWidth) problems.push(`row wider than the grid: "${row}"`);
    for (let i = 0; i < 6; i++) {
      const sep = row[i * step + width];
      if (sep !== undefined && sep !== " ") problems.push(`separator after ${DAY_NAMES[i]} is "${sep}": "${row}"`);
    }
  }
  for (let i = 0; i < 7; i++) {
    const cells = rows.map((r) => r.padEnd(gridWidth).slice(i * step, i * step + width)).reverse();
    let k = 0;
    let height = 0;
    while (k < cells.length && FILL.test(cells[k])) {
      height += cells[k][0] === "▄" ? 1 : 2;
      k++;
    }
    const label = barLabel(values[i]);
    if (cells[k] !== label.padStart(width)) problems.push(`${DAY_NAMES[i]}: expected label "${label}" above the bar, got "${cells[k]}"`);
    if (cells.slice(k + 1).some((c) => c.trim() !== "")) problems.push(`${DAY_NAMES[i]}: stray cells above the label`);
    heights.push(height);
  }
  // Future bars snap to whole rows, so against them half a row of slack is expected.
  const future = values.map((_, i) => i > today && report.days[i].spend === 0);
  for (let a = 0; a < 7; a++)
    for (let b = 0; b < 7; b++)
      if (values[a] > values[b] && heights[b] - heights[a] > (future[a] || future[b] ? 1 : 0))
        problems.push(`${DAY_NAMES[a]} (${values[a]}) is drawn lower than ${DAY_NAMES[b]} (${values[b]})`);

  const marker = lines[dayLine + 1];
  if (today >= 0 && marker !== `${" ".repeat(step * today)}▲`) problems.push(`▲ misplaced: "${marker}"`);
  if (today < 0 && marker !== undefined) problems.push("▲ drawn without a today");

  const money = Math.round(perDay).toLocaleString("ru-RU");
  if (perDay > 0 && !html.includes(`≈ ${money} ₫ в день`)) problems.push(`per-day amount should be ${money}`);
  if (perDay === 0 && html.includes("≈ ")) problems.push("per-day amount shown when nothing is left");

  if (problems.length > 0) problems.push(`chart:\n${pre}`);
  return problems;
}

const L = 400_000;
const cases: { name: string; spends: number[]; limits: number | number[]; today: number }[] = [
  { name: "screenshot: Tue over, future tallest", spends: [351_000, 473_384, 257_945, 0, 0, 0, 0], limits: L, today: 2 },
  { name: "empty week, Monday", spends: [0, 0, 0, 0, 0, 0, 0], limits: L, today: 0 },
  { name: "empty week, Sunday", spends: [0, 0, 0, 0, 0, 0, 0], limits: L, today: 6 },
  { name: "Monday tallest", spends: [900_000, 0, 0, 0, 0, 0, 0], limits: L, today: 0 },
  { name: "Sunday tallest", spends: [100_000, 200_000, 150_000, 50_000, 300_000, 120_000, 950_000], limits: L, today: 6 },
  { name: "tiny spends, limit far above bars", spends: [5_000, 2_000, 0, 0, 0, 0, 0], limits: L, today: 1 },
  { name: "tiny spends at end of week", spends: [1_000, 500, 800, 2_000, 1_200, 900, 700], limits: 2_000_000, today: 6 },
  { name: "millions: 4-char labels", spends: [5_000_000, 1_200_000, 300_000, 0, 0, 0, 0], limits: L, today: 2 },
  { name: "label rounds up to 1,0м", spends: [999_500, 999_400, 0, 0, 0, 0, 0], limits: 1_000_000, today: 1 },
  { name: "week already overspent", spends: [1_500_000, 1_500_000, 0, 0, 0, 0, 0], limits: L, today: 2 },
  { name: "today overspent, week still fine", spends: [100_000, 100_000, 700_000, 0, 0, 0, 0], limits: L, today: 2 },
  { name: "exactly on the limit", spends: [L, L, L, L, 0, 0, 0], limits: L, today: 3 },
  { name: "different daily limits", spends: [100_000, 500_000, 0, 0, 0, 0, 0], limits: [300_000, 300_000, 500_000, 500_000, 500_000, 800_000, 800_000], today: 1 },
  { name: "zero limit", spends: [100_000, 50_000, 0, 0, 0, 0, 0], limits: 0, today: 1 },
  { name: "future day with spend already", spends: [100_000, 0, 0, 0, 200_000, 0, 0], limits: L, today: 1 },
  { name: "unknown today", spends: [100_000, 300_000, 0, 0, 0, 0, 0], limits: L, today: -1 },
];

// Seeded random weeks: a mix of empty, small, near-limit and huge days.
let seed = 42;
const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
for (let n = 0; n < 2000; n++) {
  const limit = pick([0, 50_000, 400_000, 1_000_000, 3_000_000]);
  const today = pick([-1, 0, 1, 2, 3, 4, 5, 6]);
  const spends = Array.from({ length: 7 }, (_, i) => {
    if (i > today && rand() < 0.85) return 0;
    const scale = pick([0, 1_000, 50_000, limit || 400_000, (limit || 400_000) * 2, 8_000_000]);
    return Math.round(rand() * scale);
  });
  cases.push({ name: `random #${n}`, spends, limits: limit, today });
}

let failed = 0;
for (const c of cases) {
  const problems = check(week(c.spends, c.limits), c.today);
  if (problems.length === 0) continue;
  failed++;
  if (failed <= 5) console.log(`✗ ${c.name} [${c.spends.join(", ")}] limit ${c.limits} today ${c.today}\n  ${problems.join("\n  ")}\n`);
}
console.log(`${cases.length - failed}/${cases.length} report renders OK`);
process.exit(failed > 0 ? 1 : 0);
