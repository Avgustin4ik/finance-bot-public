import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  // Owners: always allowed, and the only ones who can /invite and /users.
  allowedUserIds: new Set(
    (process.env.ALLOWED_USER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  ),
  geminiApiKey: required("GEMINI_API_KEY"),
  googleServiceAccountKeyFile: required("GOOGLE_SERVICE_ACCOUNT_KEY_FILE"),
  spreadsheetId: required("SPREADSHEET_ID"),
  sheetName: process.env.SHEET_NAME ?? "Transactions",
  defaultCurrency: process.env.DEFAULT_CURRENCY ?? "VND",
  reportSheetName: process.env.REPORT_SHEET_NAME ?? "Отчет",
  // Decides which weekday is "today" in /report_week.
  reportTimezone: process.env.REPORT_TIMEZONE ?? "Asia/Ho_Chi_Minh",
  // Holds access.json (invited users and pending invites). A Docker volume in production.
  dataDir: process.env.DATA_DIR ?? "data",
};
