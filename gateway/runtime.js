import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  chmodSync,
  copyFileSync,
  rmSync,
  openSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { join } from "node:path";
import { digest, parseRoute, beforeTurn, sendReply } from "./channels.js";
import { parseA2AOutcome } from "../extension/a2a-outcome.js";
import { externalRoute, reportExternalFailure } from "./external.js";
import { deliveryNotification } from "./delivery.js";
import { hasProjectGrant, runPiTurn } from "./pi.js";

const MAX_WAITING = 256;
const CONCURRENCY = 4;
const RETRIES = [1_000, 10_000, 60_000, 300_000];
const COMMANDS = new Set(["/clear", "/new", "/status", "/stop", "/cancel"]);
const PENDING = "('queued','reply','sending','project','report')";

function flush(path) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Receives authenticated event envelopes. No network listener or tunnel is started.
 * The caller owns the supplied identity and client, both for the same account.
 */
export function createGatewayRuntime(
  config,
  { client, identity, turn = runPiTurn, reply = sendReply, logger = console },
) {
  if (!identity?.id || !config.home)
    throw new Error("Gateway identity and state directory required.");
  const dir = join(config.home, "gateway", digest(config.baseUrl, identity.id));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const owner = new DatabaseSync(join(dir, "owner.sqlite"));
  try {
    owner.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    owner.close();
    throw new Error("Another gateway owns this identity's state.", {
      cause: error,
    });
  }
  let db;
  try {
    db = new DatabaseSync(join(dir, "inbox.sqlite"));
    chmodSync(join(dir, "inbox.sqlite"), 0o600);
    db.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT UNIQUE NOT NULL, thread TEXT NOT NULL, payload TEXT, answer TEXT, actor TEXT NOT NULL,
        sequence INTEGER, command TEXT, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS receipts(event TEXT PRIMARY KEY, job TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbound(channel TEXT, message TEXT, job TEXT NOT NULL, PRIMARY KEY(channel,message));
      CREATE TABLE IF NOT EXISTS notices(channel TEXT, message TEXT, state TEXT NOT NULL, received INTEGER NOT NULL, PRIMARY KEY(channel,message));
      DELETE FROM notices WHERE received < unixepoch() - 2592000;
      CREATE INDEX IF NOT EXISTS runnable ON jobs(state, due);
      CREATE INDEX IF NOT EXISTS job_thread ON jobs(thread, state);
      CREATE TABLE IF NOT EXISTS sessions (
        thread TEXT PRIMARY KEY, revision TEXT NOT NULL, actor TEXT, sequence INTEGER
      );
      UPDATE jobs SET state='uncertain' WHERE state IN ('sending','project')`);
  } catch (error) {
    db?.close();
    owner.close();
    throw error;
  }

  const active = new Map();
  const done = Promise.withResolvers();
  done.promise.catch(() => {});
  let timer,
    closed = false,
    closeTask;
  const pathFor = (id) => join(dir, digest(id) + ".jsonl");
  const getSession = db.prepare("SELECT * FROM sessions WHERE thread=?");
  const mark = db.prepare(
    "UPDATE jobs SET state=?, payload=NULL, answer=NULL WHERE id=?",
  );
  const stateOf = db.prepare("SELECT state FROM jobs WHERE id=?");
  const saveAnswer = db.prepare(
    "UPDATE jobs SET state='reply', answer=?, payload=?, attempts=0, due=0 WHERE id=?",
  );

  function transaction(write) {
    db.exec("BEGIN IMMEDIATE");
    try {
      write();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function acceptVerified(event) {
    if (closed) throw new Error("Gateway closed.");
    if (typeof event?.id !== "string" || !event.id || event.id.length > 256)
      throw new Error("Missing event identifier.");
    if (db.prepare("SELECT 1 FROM receipts WHERE event=?").get(event.id))
      return "duplicate";
    const notice = deliveryNotification(event, identity);
    if (notice) {
      // A delivery callback can precede the send response. Retain its status, not its body.
      transaction(() => {
        db.prepare(
          `INSERT INTO notices(channel,message,state,received) VALUES(?,?,?,unixepoch())
          ON CONFLICT(channel,message) DO UPDATE SET state=CASE WHEN excluded.state='failed' THEN 'failed' ELSE notices.state END`,
        ).run(notice.channel, notice.message, notice.state);
        const sent = db
          .prepare("SELECT job FROM outbound WHERE channel=? AND message=?")
          .get(notice.channel, notice.message);
        if (sent) {
          const status = db
            .prepare("SELECT state FROM notices WHERE channel=? AND message=?")
            .get(notice.channel, notice.message).state;
          mark.run(status, sent.job);
          db.prepare("INSERT INTO receipts(event,job) VALUES(?,?)").run(
            event.id,
            sent.job,
          );
        }
      });
      return "accepted";
    }
    const route =
      event.event_type === "inbound.received"
        ? externalRoute(event, config.allowedSenders)
        : parseRoute(event, identity, config.allowedSenders, config);
    if (!route) return "ignored";
    // Distinct subscriptions can deliver a single source message under different event IDs.
    const id = digest(identity.id, route.channel, route.thread, route.message);
    if (stateOf.get(id)) {
      db.prepare("INSERT INTO receipts(event,job) VALUES(?,?)").run(
        event.id,
        id,
      );
      return "duplicate";
    }
    if (
      route.status === "existing-thread" &&
      !getSession.get(route.thread) &&
      !db
        .prepare(`SELECT 1 FROM jobs WHERE thread=? AND state IN ${PENDING}`)
        .get(route.thread)
    )
      return "ignored";
    const text = (route.control ?? route.text).trim().toLowerCase();
    const command = COMMANDS.has(text) ? text : null;
    if (
      command &&
      (route.noControls ||
        route.channel === "a2a" ||
        route.sponsored ||
        route.companion)
    )
      return "ignored";
    if (
      db.prepare(`SELECT count(*) n FROM jobs WHERE state IN ${PENDING}`).get()
        .n >=
      MAX_WAITING + (command ? 8 : 0)
    ) {
      throw new Error("Gateway queue is full.");
    }
    transaction(() => {
      db.prepare(
        "INSERT INTO jobs(id,thread,actor,sequence,command,payload,state) VALUES(?,?,?,?,?,?,?)",
      ).run(
        id,
        route.thread,
        route.sender,
        route.sequence ?? null,
        command,
        JSON.stringify(route),
        route.reportError ? "report" : "queued",
      );
      db.prepare("INSERT INTO receipts(event,job) VALUES(?,?)").run(
        event.id,
        id,
      );
    });
    schedule();
    return "accepted";
  }

  // A control can preempt the requester's own model turn. It cannot cancel, clear,
  // or disclose another sender's work, even when both share a group conversation.
  function applyControl(job, route) {
    const session = getSession.get(job.thread);
    const prior = db
      .prepare(
        `SELECT id,state,actor FROM jobs WHERE thread=? AND rowid<? AND command IS NULL AND state IN ${PENDING}`,
      )
      .all(job.thread, job.rowid);
    if (
      (session && session.actor !== route.sender) ||
      prior.some((row) => row.actor !== route.sender)
    ) {
      return "This command cannot change another sender's conversation.";
    }
    if (job.command === "/status")
      return prior.length
        ? "Pi has work in progress in this conversation."
        : "Pi is idle in this conversation.";
    if (prior.some((row) => row.state !== "queued"))
      return "A reply is already being delivered and cannot be stopped.";
    for (const row of prior) {
      mark.run("canceled", row.id);
      active.get(row.id)?.controller.abort();
    }
    if (job.command === "/clear" || job.command === "/new") {
      db.prepare("DELETE FROM sessions WHERE thread=?").run(job.thread);
      return "Conversation cleared. Your next message starts a new session.";
    }
    return prior.length ? "Stopped." : "Nothing is running.";
  }

  async function processJob(job, signal) {
    const route = JSON.parse(job.payload);
    if (job.state === "report") {
      await reportExternalFailure(route, client, identity);
      mark.run("failed", job.id);
      return;
    }
    let answer = job.answer;
    if (job.state === "queued") {
      const session = getSession.get(route.thread);
      if (
        (session?.sequence != null &&
          job.sequence != null &&
          job.sequence <= session.sequence) ||
        (route.channel !== "external" &&
          !(await beforeTurn(route, client, identity, {
            hasSession: Boolean(session),
          })))
      ) {
        if (!signal.aborted) mark.run("ignored", job.id);
        return;
      }
      if (signal.aborted) return;
      if (job.command) {
        transaction(() => {
          answer = applyControl(job, route);
          saveAnswer.run(answer, JSON.stringify(route), job.id);
        });
        if (session && !getSession.get(route.thread))
          rmSync(pathFor(session.revision), { force: true });
      } else {
        const file = pathFor(job.id);
        // A crash mid-turn never becomes the starting point for a retry.
        if (session) copyFileSync(pathFor(session.revision), file);
        else rmSync(file, { force: true });
        // These turns can already have changed a file if Pi dies. Never replay
        // them from the pre-turn transcript after an interrupted process.
        if (hasProjectGrant(config, route))
          db.prepare("UPDATE jobs SET state='project' WHERE id=?").run(job.id);
        answer = await turn(config, route, file, signal);
        if (signal.aborted) return;
        if (route.channel === "a2a") parseA2AOutcome(answer);
        flush(file);
        flush(dir);
        transaction(() => {
          const actor =
            !session || session.actor === route.sender ? route.sender : null;
          db.prepare(
            "INSERT OR REPLACE INTO sessions(thread,revision,actor,sequence) VALUES(?,?,?,?)",
          ).run(route.thread, job.id, actor, job.sequence);
          saveAnswer.run(answer, JSON.stringify(route), job.id);
        });
        if (session) rmSync(pathFor(session.revision), { force: true });
      }
    }
    if (closed || signal.aborted) return;
    if (route.channel === "external") {
      // An external event is a capture turn, not authorization to contact anyone.
      db.prepare("UPDATE jobs SET state='done', payload=NULL WHERE id=?").run(
        job.id,
      );
      return;
    }
    let result;
    if (answer.trim() && answer.trim() !== "[SILENT]") {
      // No idempotency key is available for task completion. A crash after
      // this point must not automatically repeat that terminal transition.
      if (route.channel === "a2a")
        db.prepare("UPDATE jobs SET state='sending' WHERE id=?").run(job.id);
      try {
        result = await reply(route, answer, job.id, client, identity);
      } catch (error) {
        if (route.channel !== "a2a") throw error;
        db.prepare("UPDATE jobs SET state='uncertain' WHERE id=?").run(job.id);
        logger.error("Inkbox Pi reply outcome is unknown:", job.id);
        return;
      }
    }
    transaction(() => {
      let state = "done";
      if (
        result?.id &&
        ["email", "sms", "imessage", "whatsapp"].includes(route.channel)
      ) {
        db.prepare(
          "INSERT OR REPLACE INTO outbound(channel,message,job) VALUES(?,?,?)",
        ).run(route.channel, result.id, job.id);
        state =
          db
            .prepare("SELECT state FROM notices WHERE channel=? AND message=?")
            .get(route.channel, result.id)?.state ?? "done";
      }
      mark.run(state, job.id);
    });
  }

  function retry(job, signal) {
    if (signal.aborted) return;
    const { attempts, state } = db
      .prepare("SELECT attempts,state FROM jobs WHERE id=?")
      .get(job.id);
    if (state === "project") {
      db.prepare("UPDATE jobs SET state='uncertain' WHERE id=?").run(job.id);
      logger.error("Inkbox Pi project turn was interrupted:", job.id);
      return;
    }
    if (attempts < RETRIES.length) {
      db.prepare("UPDATE jobs SET attempts=attempts+1,due=? WHERE id=?").run(
        Date.now() + RETRIES[attempts],
        job.id,
      );
    } else if (
      state === "queued" &&
      JSON.parse(job.payload).channel === "a2a"
    ) {
      // Report the unsuccessful turn to the caller; task ownership and current
      // state are checked again before the gateway submits this transition.
      const answer = JSON.stringify({
        intent: "fail",
        text: "Pi could not complete this task.",
      });
      saveAnswer.run(answer, job.payload, job.id);
    } else if (
      job.state !== "report" &&
      JSON.parse(job.payload).channel === "external"
    ) {
      db.prepare(
        "UPDATE jobs SET state='report',attempts=0,due=0 WHERE id=?",
      ).run(job.id);
    } else {
      db.prepare("UPDATE jobs SET state='failed' WHERE id=?").run(job.id);
      logger.error("Inkbox Pi delivery needs attention:", job.id);
    }
  }

  // An older pending turn blocks its thread, not unrelated conversations. A control
  // has a dedicated lane per thread; when two controls race they run in order.
  const ready =
    db.prepare(`SELECT j.rowid,j.* FROM jobs j WHERE j.state IN ('queued','reply','report') AND j.due<=?
    AND NOT EXISTS(SELECT 1 FROM jobs earlier WHERE earlier.thread=j.thread AND earlier.state IN ${PENDING}
      AND ((j.command IS NOT NULL AND earlier.command IS NOT NULL AND earlier.rowid<j.rowid) OR
       (j.command IS NULL AND (earlier.command IS NOT NULL AND earlier.rowid<j.rowid OR
        earlier.command IS NULL AND (CASE WHEN j.sequence IS NOT NULL AND earlier.sequence IS NOT NULL AND j.sequence!=earlier.sequence
          THEN earlier.sequence<j.sequence ELSE earlier.rowid<j.rowid END)))))
    ORDER BY j.command IS NULL, j.rowid`);

  function schedule() {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(pump, 0);
  }
  function pump() {
    if (closed) return;
    try {
      for (const job of ready.all(Date.now())) {
        if (active.has(job.id)) continue;
        const workers = [...active.values()];
        if (
          workers.length >= CONCURRENCY + 1 ||
          (!job.command && workers.length >= CONCURRENCY)
        )
          continue;
        if (
          workers.some(
            (w) => w.thread === job.thread && (!job.command || w.command),
          )
        )
          continue;
        const controller = new AbortController();
        const promise = processJob(job, controller.signal)
          .catch(() => retry(job, controller.signal))
          .catch(done.reject)
          .finally(() => {
            active.delete(job.id);
            schedule();
          });
        active.set(job.id, {
          thread: job.thread,
          command: job.command,
          controller,
          promise,
        });
      }
      if (!closed) {
        timer = setTimeout(pump, 1_000);
        if (
          !db
            .prepare(`SELECT 1 FROM jobs WHERE state IN ${PENDING} LIMIT 1`)
            .get()
        )
          timer.unref();
      }
    } catch (error) {
      done.reject(error);
    }
  }
  schedule();
  return {
    acceptVerified,
    eventState(eventId) {
      return (
        db
          .prepare(
            "SELECT state FROM jobs JOIN receipts ON receipts.job=jobs.id WHERE receipts.event=?",
          )
          .get(eventId)?.state ?? "unknown"
      );
    },
    eventResult(eventId) {
      return (
        db
          .prepare(
            "SELECT answer FROM jobs JOIN receipts ON receipts.job=jobs.id WHERE receipts.event=? AND state='done'",
          )
          .get(eventId)?.answer ?? null
      );
    },
    failed: done.promise,
    close() {
      if (!closeTask) {
        closed = true;
        clearTimeout(timer);
        for (const work of active.values()) work.controller.abort();
        closeTask = Promise.allSettled(
          [...active.values()].map((work) => work.promise),
        ).finally(() => {
          db.close();
          owner.close();
        });
      }
      return closeTask;
    },
  };
}
