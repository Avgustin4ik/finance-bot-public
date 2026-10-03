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
};
