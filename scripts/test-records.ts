// Manual smoke test: feeds a batch of sample messages straight through
// parseExpense + appendExpenseRow (bypassing Telegram), prints what Gemini
// extracted, verifies it in the sheet, then deletes the test rows so the
// sheet ends up exactly as it started.
//
// Run with: npm run test:records
// Keep the appended rows for manual inspection instead of auto-deleting:
// KEEP_TEST_ROWS=1 npm run test:records

import { google } from "googleapis";
import { config } from "../src/config.js";
import { parseExpense } from "../src/gemini.js";
import { appendExpenseRow } from "../src/sheets.js";

const auth = new google.auth.GoogleAuth({
  keyFile: config.googleServiceAccountKeyFile,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheetsApi = google.sheets({ version: "v4", auth });

const messages = [
  "500 продукты молоко и хлеб",
  "220000 кофе",
  "140000 кино",
  "потратил 1200 на такси",
  "заплатил 3500 за ужин в ресторане",
  "15000 аптека лекарства",
  "89 usd подписка netflix",
  "получил зарплату 150000",
  "перевод от мамы 5000",
  "вчера потратил 300 на такси",
  "сегодня 450 аптека",
  "20000 аренда квартиры",
  "2500 бензин",
  "1800 коммуналка",
  "подарок на день рождения 3000",
  "99 eur подписка spotify",
  "60000 спортзал абонемент",
  "вернули долг 10000",
  "привет как дела",
  "700 продукты",
  "фриланс доход 45000",
  "15000 стоматолог",
];

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

  const results: { msg: string; outcome: string }[] = [];

  for (const msg of messages) {
    try {
      const record = await parseExpense(msg);
      await appendExpenseRow(record, "test-script");
      const line = `OK ${record.type} ${record.amount} ${record.currency} — ${record.category} (${record.description}) via ${record.source} ${record.date}`;
      results.push({ msg, outcome: line });
      console.log(`[OK]  "${msg}" -> ${line}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ msg, outcome: `SKIPPED/ERROR: ${message}` });
      console.log(`[ERR] "${msg}" -> ${message}`);
    }
    // Free-tier Gemini is rate-limited (~15 req/min) — stay well under that.
    await new Promise((r) => setTimeout(r, 4500));
  }

  const endCount = await getRowCount();
  console.log(`\nRows after test: ${endCount} (appended ${endCount - startCount})`);

  if (endCount > startCount) {
    const verify = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: config.spreadsheetId,
      range: `${config.sheetName}!A${startCount + 1}:H${endCount}`,
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
    console.log(`${r.msg}\n  -> ${r.outcome}`);
  }
}

main().catch((err) => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
