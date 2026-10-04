import { google } from "googleapis";
import { config } from "./config.js";
import type { ExpenseRecord } from "./types.js";

const auth = new google.auth.GoogleAuth({
  keyFile: config.googleServiceAccountKeyFile,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

export async function appendExpenseRow(record: ExpenseRecord): Promise<void> {
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.spreadsheetId,
    range: `${config.sheetName}!A:G`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [
        [record.date, record.type, record.source, record.amount, record.currency, record.category, record.description],
      ],
    },
  });
}
