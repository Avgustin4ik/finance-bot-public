// User-facing release notes, newest first. Add an entry with a new `id` whenever a deploy changes something
// users would notice: on startup the bot silently sends the newest entry to every user, once per id.
// Use the deploy date as the id, with a suffix for a second release on the same day (e.g. "2026-11-14.2").
// The real release notes live in the private repo; this public copy keeps one example entry.
export interface ChangelogEntry {
  id: string;
  changes: string[];
}

export const changelog: ChangelogEntry[] = [
  {
    id: "2026-01-01",
    changes: ["Пример записи: что нового в этом обновлении."],
  },
];
