import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changelog, type ChangelogEntry } from "./changelog-entries.js";
import { config } from "./config.js";

export type { ChangelogEntry };

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

export function latestEntry(): ChangelogEntry {
  return changelog[0];
}

export function formatEntry(entry: ChangelogEntry): string {
  const [year, month, day] = entry.id.split(/[-.]/).map(Number);
  const date = `${day} ${MONTHS[month - 1]} ${year}`;
  return `🆕 Обновление от ${date}\n\n${entry.changes.map((change) => `• ${change}`).join("\n")}`;
}

// Ids already sent, so a restart doesn't repeat an announcement and a rollback doesn't re-send an old one.
const stateFile = join(config.dataDir, "announced.json");

function loadAnnounced(): string[] {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8")) as string[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export function isAnnounced(id: string): boolean {
  return loadAnnounced().includes(id);
}

// Write to a temp file and rename, so a crash mid-write can't leave a truncated file.
export function markAnnounced(id: string): void {
  mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${stateFile}.tmp`;
  writeFileSync(tmp, JSON.stringify([...loadAnnounced(), id], null, 2));
  renameSync(tmp, stateFile);
}
