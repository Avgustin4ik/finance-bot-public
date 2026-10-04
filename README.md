# Family Finance Bot

Private Telegram bot for two people. Send it a text message describing an expense/income,
it parses it with Gemini (free tier) and appends a row to a Google Sheet.

**Iteration 1 scope:** text messages only.

## Setup

1. **Telegram bot token**
   - Message [@BotFather](https://t.me/BotFather) on Telegram, run `/newbot`, copy the token.
   - Put it in `.env` as `TELEGRAM_BOT_TOKEN`.

2. **Gemini API key (free tier)**
   - Get a key at https://aistudio.google.com/apikey.
   - Put it in `.env` as `GEMINI_API_KEY`.

3. **Google service account for Sheets**
   - In [Google Cloud Console](https://console.cloud.google.com/), create a project (or reuse one).
   - Enable the **Google Sheets API** for it.
   - Create a **Service Account**, then create a JSON key for it and download it.
   - Save the JSON file as `service-account.json` in this repo's root (it's gitignored).
   - Open your spreadsheet, click **Share**, and share it with the service account's email
     (looks like `xxx@yyy.iam.gserviceaccount.com`) with **Editor** access.
   - Put the spreadsheet ID (the long string in its URL between `/d/` and `/edit`) in `.env`
     as `SPREADSHEET_ID`.
   - Make sure the spreadsheet has a tab named exactly as `SHEET_NAME` in `.env`
     (default: `Transactions`), with columns: date, type, source, amount, currency, category, description.

4. **Allowlist (access control)**
   - Leave `ALLOWED_USER_IDS` empty at first, start the bot, and message it from Telegram
     (both you and your partner). The console will log each unauthorized sender's numeric
     user ID, e.g. `Unauthorized access attempt from user id=123456789 ...`.
   - Copy both IDs into `.env` as `ALLOWED_USER_IDS=123456789,987654321`, then restart the bot.

5. **Install and run**
   ```
   npm install
   cp .env.example .env   # fill in the values from steps above
   npm run dev
   ```

## Usage

Send the bot a plain-text message like:

- `500 groceries milk and eggs`
- `-2000 salary`
- `paid 35 for lunch yesterday`

It replies confirming what it recorded, and appends a row to the sheet.

## Next iterations

- Voice messages (transcription before parsing).
- Photos (receipts) via image understanding.
