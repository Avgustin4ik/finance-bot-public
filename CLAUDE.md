# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

This repository is a blank slate — no source code, package manifest, or build tooling exists yet. The only
content is `goal.md`, which is the project brief. Read it before starting any work; it is the source of
truth for scope and constraints until real code and docs replace it.

## Project goal (from goal.md)

A private family finance Telegram bot, for the repo owner and their partner only:

- Accepts voice messages, text messages, and photos from Telegram.
- Transcribes/reads the content, sends it to Claude for understanding, and writes a structured record into
  a specific sheet of a personal Google Sheets spreadsheet (the target sheet will be specified later).
- Must restrict access to just the two authorized users — incoming senders need to be checked/allowlisted.
- The owner has no paid Claude API budget, so the implementation needs to work within that constraint
  (e.g. a free-tier-friendly approach) rather than assuming a standard paid API integration.
- Language/stack is unspecified by the owner (TypeScript is suggested as a default, not a requirement) —
  decide the stack when implementation starts.
- Build iteratively: each iteration must be a complete, working product on its own. Iteration 1 scope is
  text messages only: receive → read → send to Claude → write the record.

## Claude Code `telegram` plugin

The official `telegram` plugin is enabled in `.claude/settings.json`. It adds two skills relevant to this
project:

- `telegram:configure` — save the bot token and review the access policy for the Telegram channel.
- `telegram:access` — manage pairing approvals and the DM/group allowlist for that channel.

These skills configure a Telegram channel *for Claude Code itself* (i.e. messaging this Claude Code session
over Telegram, with access control), which is distinct from writing custom bot application code. When
picking an implementation approach for goal.md, consider whether this built-in channel feature can satisfy
the "private bot with access control" requirement directly, versus building a standalone bot from scratch.
