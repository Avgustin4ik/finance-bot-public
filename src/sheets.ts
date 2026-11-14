import { google } from "googleapis";
import { config } from "./config.js";
import type { ExpenseRecord } from "./types.js";

const auth = new google.auth.GoogleAuth({
  keyFile: config.googleServiceAccountKeyFile,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

// Numbers come back raw and dates as serial numbers, so callers don't depend on the sheet's locale formatting.
export async function readRange(range: string): Promise<unknown[][]> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "SERIAL_NUMBER",
  });
  return res.data.values ?? [];
}

export async function appendExpenseRow(record: ExpenseRecord): Promise<void> {
  await appendExpenseRows([record]);
}

// Appends all records in one API call, so a batch is written all-or-nothing.
// The sheet has pre-filled rows below the data with formulas (E "Валюта" from the account, L–S rates and
// totals). OVERWRITE fills the next of those rows in place — INSERT_ROWS would insert a blank row without
// them — and null leaves the E formula untouched (the API skips null cells).
export async function appendExpenseRows(records: ExpenseRecord[]): Promise<void> {
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.spreadsheetId,
    range: `${config.sheetName}!A:G`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "OVERWRITE",
    requestBody: {
      values: records.map((record) => [
        record.date,
        record.type,
        record.source,
        record.amount,
        null,
        record.category,
        record.description,
      ]),
    },
  });
}

// The last data row, as the sheet displays it (A–G: date, type, source, amount, currency, category, description).
export interface SheetRow {
  rowNumber: number;
  values: string[];
}

// Clears the last row with a date in column A and returns what it held, or null if only the header is left.
// Like appendExpenseRows, it touches only A–D and F–G: the row's pre-filled formulas (E, L–S) stay in place,
// so the next append fills this row again.
export async function deleteLastExpenseRow(): Promise<SheetRow | null> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: `${config.sheetName}!A:G`,
  });
  const rows = res.data.values ?? [];
  // Formula rows below the data have an empty A, and the API trims trailing empty rows — but not rows that
  // only have E filled, so walk back to the last row that actually has a date.
  let index = rows.length - 1;
  while (index > 0 && !String(rows[index]?.[0] ?? "").trim()) index--;
  if (index < 1) return null; // Row 1 is the header.

  const rowNumber = index + 1;
  await sheets.spreadsheets.values.batchClear({
    spreadsheetId: config.spreadsheetId,
    requestBody: {
      ranges: [`${config.sheetName}!A${rowNumber}:D${rowNumber}`, `${config.sheetName}!F${rowNumber}:G${rowNumber}`],
    },
  });
  return { rowNumber, values: Array.from({ length: 7 }, (_, i) => String(rows[index][i] ?? "")) };
}
