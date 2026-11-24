// A provider can report delivery before returning the outgoing message ID to
// the sender. Keep event aliases until they can point to the original job.
export function openDeliveryJournal(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS early_receipts(event TEXT PRIMARY KEY, channel TEXT NOT NULL, message TEXT NOT NULL, received INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS early_message ON early_receipts(channel,message);
    DELETE FROM early_receipts WHERE received < unixepoch() - 2592000;
    CREATE TABLE IF NOT EXISTS delivery_seen(job TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS delivery_resets(thread TEXT PRIMARY KEY, through_row INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS outbound_job ON outbound(job);`);
  const pending = db.prepare(`
    SELECT id, state FROM (
      SELECT j.id, j.rowid AS position, s.state AS seen,
        COALESCE(n.state, CASE WHEN j.answer IS NOT NULL AND o.job IS NULL
          AND j.state IN ('failed','uncertain') THEN j.state END) AS state
      FROM jobs j LEFT JOIN outbound o ON o.job=j.id
      LEFT JOIN notices n ON n.channel=o.channel AND n.message=o.message
      LEFT JOIN delivery_seen s ON s.job=j.id
      WHERE j.thread=? AND j.actor=? AND j.command IS NULL AND j.rowid<?
        AND j.rowid>COALESCE((SELECT through_row FROM delivery_resets WHERE thread=j.thread),0))
    WHERE state IS NOT NULL AND state IS NOT seen ORDER BY position LIMIT 25`);
  return {
    isEarly(event) {
      return db
        .prepare("SELECT 1 FROM early_receipts WHERE event=?")
        .get(event);
    },
    defer(event, channel, message) {
      db.prepare("INSERT INTO early_receipts VALUES(?,?,?,unixepoch())").run(
        event,
        channel,
        message,
      );
    },
    bind(job, channel, message) {
      db.prepare(
        "INSERT INTO receipts(event,job) SELECT event,? FROM early_receipts WHERE channel=? AND message=?",
      ).run(job, channel, message);
      db.prepare(
        "DELETE FROM early_receipts WHERE channel=? AND message=?",
      ).run(channel, message);
    },
    unread(job) {
      return pending.all(job.thread, job.actor, job.rowid);
    },
    seen(rows) {
      const save = db.prepare(
        "INSERT OR REPLACE INTO delivery_seen(job,state) VALUES(?,?)",
      );
      for (const row of rows) save.run(row.id, row.state);
    },
    clear(job) {
      db.prepare(
        "INSERT OR REPLACE INTO delivery_resets(thread,through_row) VALUES(?,?)",
      ).run(job.thread, job.rowid);
    },
  };
}

export function describeDelivery(rows) {
  if (!rows.length) return;
  const failed = rows.filter((row) => row.state === "failed").length;
  return `Earlier replies to this sender in this conversation: ${failed} reported failed, ${rows.length - failed} unconfirmed. Unconfirmed does not mean failed. This status is not authorization to resend or change channel.`;
}
