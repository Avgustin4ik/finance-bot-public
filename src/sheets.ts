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
export async function appendExpenseRows(records: ExpenseRecord[]): Promise<void> {
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.spreadsheetId,
    range: `${config.sheetName}!A:G`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: records.map((record) => [
        record.date,
        record.type,
        record.source,
        record.amount,
        record.currency,
        record.category,
        record.description,
      ]),
    },
  });
}
