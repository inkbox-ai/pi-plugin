import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync, copyFileSync, rmSync, openSync, closeSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import { digest, parseRoute, beforeTurn, sendReply } from "./channels.js";
import { runPiTurn } from "./pi.js";

const MAX_WAITING = 256;
const RETRIES = [1_000, 10_000, 60_000, 300_000];

export function createGatewayRuntime(config, { client, identity, turn = runPiTurn, reply = sendReply, logger = console }) {
  if (!identity?.id || !config.home) throw new Error("Gateway identity and state directory required.");
  const dir = join(config.home, "gateway", digest(config.baseUrl, identity.id));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const owner = new DatabaseSync(join(dir, "owner.sqlite"));
  try { owner.exec("BEGIN EXCLUSIVE"); } catch (error) {
    owner.close();
    throw new Error("Another gateway owns this identity's state.", { cause: error });
  }
  let db;
  try {
    db = new DatabaseSync(join(dir, "inbox.sqlite"));
    chmodSync(join(dir, "inbox.sqlite"), 0o600);
    db.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT UNIQUE NOT NULL, thread TEXT NOT NULL, payload TEXT, answer TEXT,
        state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS runnable ON jobs(state, due);
      CREATE TABLE IF NOT EXISTS sessions (thread TEXT PRIMARY KEY, revision TEXT NOT NULL)`);
  } catch (error) { db?.close(); owner.close(); throw error; }
  const abort = new AbortController();
  let running, timer, closed = false;
  const pathFor = (id) => join(dir, digest(id) + ".jsonl");
  const getSession = db.prepare("SELECT revision FROM sessions WHERE thread=?");
  const mark = db.prepare("UPDATE jobs SET state=?, payload=NULL, answer=NULL WHERE id=?");

  function acceptVerified(event) {
    if (closed) throw new Error("Gateway closed.");
    const route = parseRoute(event, identity, config.allowedSenders);
    if (!route) return "ignored";
    // Provider retries and different subscriptions for the same source message share one receipt.
    const id = digest(identity.id, route.channel, route.thread, route.message);
    if (db.prepare("SELECT 1 FROM jobs WHERE id=?").get(id)) return "duplicate";
    if (route.status === "existing-thread" && !getSession.get(route.thread) &&
        !db.prepare("SELECT 1 FROM jobs WHERE thread=? AND state IN ('queued','reply')").get(route.thread)) return "ignored";
    if (db.prepare("SELECT count(*) n FROM jobs WHERE state IN ('queued','reply')").get().n >= MAX_WAITING) {
      throw new Error("Gateway queue is full.");
    }
    db.prepare("INSERT INTO jobs(id,thread,payload,state) VALUES(?,?,?,'queued')").run(id, route.thread, JSON.stringify(route));
    wake();
    return "accepted";
  }

  async function processJob(job) {
    const route = JSON.parse(job.payload);
    let answer = job.answer;
    if (job.state === "queued") {
      if (!await beforeTurn(route, client, identity)) {
        mark.run("ignored", job.id);
        return;
      }
      const previous = getSession.get(route.thread)?.revision;
      const file = pathFor(job.id);
      // A crash mid-turn never becomes the starting point for a retry.
      if (previous) copyFileSync(pathFor(previous), file);
      else rmSync(file, { force: true });
      answer = await turn(config, route, file, abort.signal);
      const fd = openSync(file, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      const directory = openSync(dir, "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT OR REPLACE INTO sessions(thread,revision) VALUES(?,?)").run(route.thread, job.id);
        db.prepare("UPDATE jobs SET state='reply', answer=?, payload=?, attempts=0, due=0 WHERE id=?").run(answer, JSON.stringify(route), job.id);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      if (previous) rmSync(pathFor(previous), { force: true });
    }
    if (closed) return;
    if (answer.trim() && answer.trim() !== "[SILENT]") {
      await reply(route, answer, job.id, client, identity);
    }
    mark.run("done", job.id);
  }

  const next = db.prepare(`SELECT j.* FROM jobs j WHERE j.state IN ('queued','reply') AND j.due<=?
    AND NOT EXISTS(SELECT 1 FROM jobs earlier WHERE earlier.thread=j.thread AND earlier.rowid<j.rowid
    AND earlier.state IN ('queued','reply')) ORDER BY j.rowid LIMIT 1`);
  async function drain() {
    while (!closed) {
      const job = next.get(Date.now());
      if (!job) break;
      try { await processJob(job); }
      catch {
        if (closed) return;
        const { attempts } = db.prepare("SELECT attempts FROM jobs WHERE id=?").get(job.id);
        if (attempts < RETRIES.length) {
          db.prepare("UPDATE jobs SET attempts=attempts+1,due=? WHERE id=?").run(Date.now()+RETRIES[attempts], job.id);
        } else {
          db.prepare("UPDATE jobs SET state='failed' WHERE id=?").run(job.id);
          logger.error("Inkbox Pi delivery needs attention:", job.id);
        }
      }
    }
  }
  const failed = Promise.withResolvers();
  failed.promise.catch(() => {});
  function wake() {
    if (running || closed) return;
    clearTimeout(timer);
    running = Promise.resolve().then(drain).catch((error) => failed.reject(error)).finally(() => {
      running = undefined;
      if (!closed) { timer = setTimeout(wake, 1_000); timer.unref(); }
    });
  }
  wake();
  return {
    acceptVerified,
    failed: failed.promise,
    async close() {
      closed = true;
      clearTimeout(timer);
      abort.abort();
      try { await running; } finally { db.close(); owner.close(); }
    },
  };
}
