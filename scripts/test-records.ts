// Manual smoke test: feeds a batch of sample messages straight through
// parseExpenses + appendExpenseRows (bypassing Telegram), checks that Gemini
// found the expected number of records per message, verifies them in the
// sheet, then deletes the test rows so the sheet ends up exactly as it started.
// The Accept/Cancel confirmation for multi-record messages lives in the
// Telegram layer and is not exercised here — every parsed batch is written.
//
// Run with: npm run test:records
// Keep the appended rows for manual inspection instead of auto-deleting:
// KEEP_TEST_ROWS=1 npm run test:records

import { google } from "googleapis";
import { config } from "../src/config.js";
import { parseExpenses } from "../src/gemini.js";
import { appendExpenseRows } from "../src/sheets.js";

const auth = new google.auth.GoogleAuth({
  keyFile: config.googleServiceAccountKeyFile,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheetsApi = google.sheets({ version: "v4", auth });

// expected = number of records Gemini should extract (0 = not a transaction).
// Single-record messages (original set) — must keep producing exactly one record.
const singleMessages = [
  { msg: "500 продукты молоко и хлеб", expected: 1 },
  { msg: "220000 кофе", expected: 1 },
  { msg: "140000 кино", expected: 1 },
  { msg: "потратил 1200 на такси", expected: 1 },
  { msg: "заплатил 3500 за ужин в ресторане", expected: 1 },
  { msg: "15000 аптека лекарства", expected: 1 },
  { msg: "89 usd подписка netflix", expected: 1 },
  { msg: "получил зарплату 150000", expected: 1 },
  { msg: "перевод от мамы 5000", expected: 1 },
  { msg: "вчера потратил 300 на такси", expected: 1 },
  { msg: "сегодня 450 аптека", expected: 1 },
  { msg: "20000 аренда квартиры", expected: 1 },
  { msg: "2500 бензин", expected: 1 },
  { msg: "1800 коммуналка", expected: 1 },
  { msg: "подарок на день рождения 3000", expected: 1 },
  { msg: "99 eur подписка spotify", expected: 1 },
  { msg: "60000 спортзал абонемент", expected: 1 },
  { msg: "вернули долг 10000", expected: 1 },
  { msg: "привет как дела", expected: 0 },
  { msg: "700 продукты", expected: 1 },
  { msg: "фриланс доход 45000", expected: 1 },
  { msg: "15000 стоматолог", expected: 1 },
];

// Multi-record "summary" messages.
const multiMessages = [
  { msg: "50k на кофе, 33000 косметический магазин и 500k продукты", expected: 3 },
  { msg: "50k for coffee, 33000 for cosmetic store and 500k for groceries", expected: 3 },
  { msg: "такси 80к, обед 150к", expected: 2 },
  { msg: "вчера: бензин 100000, мойка байка 50000", expected: 2 },
  { msg: "получил зарплату 150000 и вернули долг 10000", expected: 2 },
  { msg: "аренда 8 млн, интернет 250к, электричество 900к, вода 120к", expected: 4 },
  { msg: "кофе 45к наличными, продукты 320к картой", expected: 2 },
  { msg: "netflix 15 usd, spotify 11 usd", expected: 2 },
  { msg: "купил в супермаркете молоко, хлеб и яйца за 210к", expected: 1 },
  { msg: "аптека 120к\nкафе 200к\nгрэб 60к", expected: 3 },
];

const messages = [...singleMessages, ...multiMessages];

const KEEP_ROWS = process.env.KEEP_TEST_ROWS === "1";

async function getRowCount(): Promise<number> {
  const res = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: `${config.sheetName}!A:A`,
  });
  return res.data.values?.length ?? 0;
}

async function getSheetIdByName(name: string): Promise<number> {
  const res = await sheetsApi.spreadsheets.get({ spreadsheetId: config.spreadsheetId });
  const sheet = res.data.sheets?.find((s) => s.properties?.title === name);
  if (!sheet || sheet.properties?.sheetId == null) {
    throw new Error(`Sheet tab "${name}" not found`);
  }
  return sheet.properties.sheetId;
}

async function deleteRows(sheetId: number, startIndex: number, endIndex: number): Promise<void> {
  await sheetsApi.spreadsheets.batchUpdate({
    spreadsheetId: config.spreadsheetId,
    requestBody: {
      requests: [
        { deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex, endIndex } } },
      ],
    },
  });
}

async function main() {
  const sheetId = await getSheetIdByName(config.sheetName);
  const startCount = await getRowCount();
  console.log(`Sheet "${config.sheetName}" found (id=${sheetId}). Rows before test: ${startCount}`);

  const results: { msg: string; pass: boolean; outcome: string }[] = [];

  for (const { msg, expected } of messages) {
    try {
      const records = await parseExpenses(msg);
      await appendExpenseRows(records);
      const pass = records.length === expected;
      const lines = records.map(
        (record) =>
          `${record.type} ${record.amount} ${record.currency} — ${record.category} (${record.description}) via ${record.source} ${record.date}`
      );
      const outcome = `${records.length}/${expected} records\n     ${lines.join("\n     ")}`;
      results.push({ msg, pass, outcome });
      console.log(`[${pass ? "OK" : "FAIL"}] "${msg}" -> ${outcome}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const pass = expected === 0 && message === "not_a_transaction";
      results.push({ msg, pass, outcome: `0/${expected} records: ${message}` });
      console.log(`[${pass ? "OK" : "FAIL"}] "${msg}" -> ${message}`);
    }
    // Free-tier Gemini is rate-limited (~15 req/min) — stay well under that.
    await new Promise((r) => setTimeout(r, 4500));
  }

  const endCount = await getRowCount();
  console.log(`\nRows after test: ${endCount} (appended ${endCount - startCount})`);

  if (endCount > startCount) {
    const verify = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: config.spreadsheetId,
      range: `${config.sheetName}!A${startCount + 1}:G${endCount}`,
    });
    console.log("\n=== Appended rows (as read back from the sheet) ===");
    for (const row of verify.data.values ?? []) {
      console.log(row.join(" | "));
    }

    if (KEEP_ROWS) {
      console.log("\nKEEP_TEST_ROWS=1 set — leaving test rows in the sheet for inspection.");
    } else {
      await deleteRows(sheetId, startCount, endCount);
      console.log(`\nDeleted test rows ${startCount + 1}..${endCount}. Sheet restored to original state.`);
    }
  } else {
    console.log("\nNo rows were appended, nothing to clean up.");
  }

  console.log("\n=== SUMMARY ===");
  for (const r of results) {
    console.log(`[${r.pass ? "OK" : "FAIL"}] ${r.msg}\n  -> ${r.outcome}`);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed.`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
