#!/usr/bin/env bash
# One-time VPS bootstrap (Debian/Ubuntu). Run as root:
#   ssh root@<vps> 'bash -s' < deploy/setup-vps.sh
#
# Installs Docker, creates a `deploy` user that GitHub Actions logs in as,
# and creates /opt/finance-bot for the bot's config and secrets.
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-deploy}"
APP_DIR="/opt/finance-bot"

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi
usermod -aG docker "$DEPLOY_USER"

install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
touch "/home/$DEPLOY_USER/.ssh/authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh/authorized_keys"
chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys"

install -d -m 750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR"

cat <<MSG

VPS ready. Next:
  1. Append the CI public key to /home/$DEPLOY_USER/.ssh/authorized_keys
  2. Put bot.env and service-account.json into $APP_DIR (owned by $DEPLOY_USER, chmod 600)
MSG
