import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { digest } from "./channels.js";

export function journalDirectory(config, identity) {
  return join(config.home, "gateway", digest(config.baseUrl, identity.id));
}

// Inspect the exact identity's journal without acquiring gateway ownership.
export function inspectJournal(config, identity, eventId) {
  const file = join(journalDirectory(config, identity), "inbox.sqlite");
  const missing = eventId ? { state: "unknown" } : { initialized: false };
  if (!existsSync(file)) return missing;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (!eventId) {
      const counts = db
        .prepare("SELECT state, count(*) AS count FROM jobs GROUP BY state")
        .all();
      return {
        initialized: true,
        counts: Object.fromEntries(counts.map((row) => [row.state, row.count])),
      };
    }
    const row = db
      .prepare(
        `SELECT j.state, CASE WHEN j.state='done' THEN j.answer END AS result,
      d.category, d.attempt FROM receipts r JOIN jobs j ON j.id=r.job
      LEFT JOIN diagnostics d ON d.job=j.id WHERE r.event=?`,
      )
      .get(eventId);
    return row ?? missing;
  } finally {
    db.close();
  }
}
