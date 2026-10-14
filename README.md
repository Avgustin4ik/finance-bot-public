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

## Deployment (CI/CD)

Every push to `main` runs **GitHub Actions** (`.github/workflows/ci-cd.yml`):

1. **check**: `npm ci`, typecheck, build. This also runs on pull requests.
2. **image**: builds the Docker image and pushes it to GHCR as `sha-<commit>` and `latest`.
3. **deploy**: SSHes into the VPS and runs `deploy/deploy.sh`. The script pulls the image,
   restarts the bot and waits 20s. If the bot isn't still running, it **rolls back
   automatically** to the previous image and the workflow fails.

### Day-to-day workflow

```
git checkout -b my-feature    # optional, PRs get checked but not deployed
# ...edit code, test locally with `npm run dev`...
git commit -am "Add X"
git push                      # pushing / merging to main deploys
```

**Use a separate dev bot for local testing.** Only one process can poll a bot token at a time,
so running `npm run dev` with the production token fights with the VPS (409 Conflict).
Create a second bot in @BotFather and put its token in your local `.env`.

**Rollback:** GitHub → Actions → CI/CD → *Run workflow* → enter an old tag (e.g. `sha-1a2b3c4`,
listed under the repo's *Packages*). This redeploys that image without rebuilding.

**Logs on the VPS:** `cd /opt/finance-bot && docker compose logs -f bot`

### One-time setup

1. **Push this repo to GitHub** (a private repo is fine):
   ```
   gh auth login
   git branch -M main
   gh repo create finance-bot --private --source . --push
   ```

2. **Bootstrap the VPS** (Debian/Ubuntu). This installs Docker, creates a `deploy` user and
   creates `/opt/finance-bot`:
   ```
   ssh root@<VPS_IP> 'bash -s' < deploy/setup-vps.sh
   ```

3. **Create a deploy SSH key** (on your machine) and authorize it on the VPS:
   ```
   ssh-keygen -t ed25519 -N "" -C finance-bot-ci -f ~/.ssh/finance-bot-ci
   ssh root@<VPS_IP> 'cat >> /home/deploy/.ssh/authorized_keys' < ~/.ssh/finance-bot-ci.pub
   ```

4. **Put the bot's secrets on the VPS.** They never go into git or GitHub:
   ```
   cp deploy/bot.env.example /tmp/bot.env   # fill in real values
   scp -i ~/.ssh/finance-bot-ci /tmp/bot.env service-account.json deploy@<VPS_IP>:/opt/finance-bot/
   ssh -i ~/.ssh/finance-bot-ci deploy@<VPS_IP> 'chmod 600 /opt/finance-bot/{bot.env,service-account.json}'
   rm /tmp/bot.env
   ```

5. **Add GitHub secrets** (repo → Settings → Secrets and variables → Actions):
   ```
   gh secret set VPS_HOST --body "<VPS_IP>"
   gh secret set VPS_USER --body "deploy"
   gh secret set VPS_SSH_KEY < ~/.ssh/finance-bot-ci
   ssh-keyscan -H <VPS_IP> | gh secret set VPS_KNOWN_HOSTS
   # only if SSH isn't on port 22:
   gh secret set VPS_PORT --body "2222"
   ```

6. **Stop any local copy of the bot that uses the production token**, then trigger the first
   deploy: `gh workflow run CI/CD`, or push a commit to `main`.

To change a secret later (e.g. add your partner's ID to `ALLOWED_USER_IDS`), edit
`/opt/finance-bot/bot.env` on the VPS and run `docker compose up -d` in that directory.

## Next iterations

- Voice messages (transcription before parsing).
- Photos (receipts) via image understanding.
