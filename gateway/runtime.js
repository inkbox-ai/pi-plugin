import { identityStatus } from "./identity-status.js";
import { journalDirectory } from "./journal.js";
import {
  createPermissions,
  DEFAULT_PERMISSION_TIMEOUT_S,
  withoutMention,
} from "./permissions.js";
import { createContactResolver, describeSender } from "./contacts.js";
import { stripMarkdown } from "./prompts.js";
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
import {
  completionSource,
  transcriptSource,
  waitsForTranscript,
} from "./media.js";
import { boundedReply } from "./reply-limits.js";
import { failureCategory } from "./diagnostics.js";
import { problem } from "../cli/errors.js";
import { describeDelivery, openDeliveryJournal } from "./delivery-journal.js";
import { deliveryNotification } from "./delivery.js";
import { runPiTurn } from "./pi.js";

const MAX_WAITING = 256;
const CONCURRENCY = 4;
const RETRIES = [1_000, 10_000, 60_000, 300_000];
const COMMANDS = new Set(["/clear", "/new", "/status", "/stop", "/cancel"]);
const PENDING = "('queued','reply','sending','running','report')";
const commandText = (route) =>
  (route.control ?? route.text).trim().toLowerCase();
// A known person is the same actor on every channel they write from.
const actorOf = (route) => route.person ?? route.sender;
// An approval question belongs to the conversation it was asked in.
const askedIn = (route) => route.conversationThread ?? route.thread;

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
  { paused = false, slackConnected } = {},
) {
  if (!identity?.id || !config.home)
    throw problem("Gateway identity and state directory required.");
  const turnConfig = {
    ...config,
    identityId: identity.id,
    identity: identity.agentHandle || config.identity,
    ...identityStatus(identity, config.slackEnabled, slackConnected),
  };
  const dir = journalDirectory(config, identity);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const owner = new DatabaseSync(join(dir, "owner.sqlite"));
  try {
    owner.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    owner.close();
    throw problem(
      "Another gateway owns this identity's state. Stop it before starting another.",
    );
  }
  let db, delivery;
  try {
    db = new DatabaseSync(join(dir, "inbox.sqlite"));
    chmodSync(join(dir, "inbox.sqlite"), 0o600);
    db.exec(`PRAGMA busy_timeout=3000;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT UNIQUE NOT NULL, thread TEXT NOT NULL, payload TEXT, answer TEXT, actor TEXT NOT NULL,
        sequence INTEGER, command TEXT, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS receipts(event TEXT PRIMARY KEY, job TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media_wait(job TEXT PRIMARY KEY, source TEXT NOT NULL, deadline INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS waiting_source ON media_wait(source);
      CREATE TRIGGER IF NOT EXISTS media_finished AFTER UPDATE OF state ON jobs WHEN NEW.state != 'queued'
        BEGIN DELETE FROM media_wait WHERE job=NEW.id; END;
      CREATE TABLE IF NOT EXISTS diagnostics(job TEXT PRIMARY KEY, attempt INTEGER NOT NULL, category TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbound(channel TEXT, message TEXT, job TEXT NOT NULL, PRIMARY KEY(channel,message));
      CREATE TABLE IF NOT EXISTS notices(channel TEXT, message TEXT, state TEXT NOT NULL, received INTEGER NOT NULL, PRIMARY KEY(channel,message));
      DELETE FROM notices WHERE received < unixepoch() - 2592000;
      CREATE INDEX IF NOT EXISTS runnable ON jobs(state, due);
      CREATE INDEX IF NOT EXISTS job_thread ON jobs(thread, state);
      CREATE TABLE IF NOT EXISTS slack_session_generations(thread TEXT PRIMARY KEY, generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        thread TEXT PRIMARY KEY, revision TEXT NOT NULL, actor TEXT, sequence INTEGER
      );
      UPDATE jobs SET state='uncertain' WHERE state IN ('sending','project','running')`);
    db.exec("BEGIN IMMEDIATE");
    delivery = openDeliveryJournal(db);
    db.exec("COMMIT");
  } catch (error) {
    db?.close();
    owner.close();
    throw error;
  }

  const active = new Map();
  const permissions = createPermissions();
  const resolveContact = createContactResolver(client);
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
    if (
      db.prepare("SELECT 1 FROM receipts WHERE event=?").get(event.id) ||
      delivery.isEarly(event.id)
    )
      return "duplicate";
    if (event.event_type === "message.transcription_finished") {
      const source = completionSource(event);
      if (!source) return "ignored";
      const updated = db
        .prepare(
          "UPDATE jobs SET due=0 WHERE state='queued' AND id IN (SELECT job FROM media_wait WHERE source=?)",
        )
        .run(source);
      if (updated.changes) schedule();
      return updated.changes ? "accepted" : "ignored";
    }
    const notice = deliveryNotification(event, identity);
    if (notice) {
      // A delivery callback can precede the send response. Retain its status, not its body.
      transaction(() => {
        db.prepare(
          `INSERT INTO notices(channel,message,state,received) VALUES(?,?,?,unixepoch())
          ON CONFLICT(channel,message) DO UPDATE SET state=CASE WHEN excluded.state='failed' THEN 'failed' ELSE notices.state END, received=excluded.received`,
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
        } else {
          delivery.defer(event.id, notice.channel, notice.message);
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
    let id = digest(
      identity.id,
      route.channel,
      route.source ?? route.thread,
      route.message,
    );
    // Older journals used each top-level phone message's own ID as a subthread.
    // Preserve the original receipt if that source is replayed after upgrading.
    if (
      !route.subthread &&
      !route.companion &&
      ["imessage", "whatsapp"].includes(route.channel)
    ) {
      const legacyThread = digest(
        route.channel,
        route.connection,
        route.conversation,
        route.message,
      );
      const legacy = digest(
        identity.id,
        route.channel,
        legacyThread,
        route.message,
      );
      if (stateOf.get(legacy)) id = legacy;
    }
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
    // While an approval question is open, the asker's next message answers it.
    if (
      route.channel !== "a2a" &&
      route.channel !== "external" &&
      permissions.answer(
        askedIn(route),
        route.sender,
        withoutMention(route.control ?? route.text, identity.agentHandle),
      ) === "answered"
    ) {
      transaction(() => {
        db.prepare(
          "INSERT INTO jobs(id,thread,actor,command,state) VALUES(?,?,?,'/permission','done')",
        ).run(id, route.thread, actorOf(route));
        db.prepare("INSERT INTO receipts(event,job) VALUES(?,?)").run(
          event.id,
          id,
        );
      });
      return "accepted";
    }
    const text = commandText(route);
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
        actorOf(route),
        route.sequence ?? null,
        command,
        JSON.stringify(route),
        route.reportError ? "report" : "queued",
      );
      if (waitsForTranscript(route)) {
        const source = transcriptSource(route);
        if (source)
          db.prepare(
            "INSERT INTO media_wait(job,source,deadline) VALUES(?,?,?)",
          ).run(id, source, Date.now() + 60_000);
      }
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
    const actor = actorOf(route);
    if (
      (session && session.actor !== actor) ||
      prior.some((row) => row.actor !== actor)
    ) {
      return "This command cannot change another sender's conversation.";
    }
    if (job.command === "/status")
      return prior.length
        ? "Pi has work in progress in this conversation."
        : "Pi is idle in this conversation.";
    const stoppingTurn = prior.some((row) => row.state === "running");
    if (prior.some((row) => row.state !== "queued" && row.state !== "running"))
      return "A reply is already being delivered and cannot be stopped.";
    for (const row of prior) {
      // A running turn may already have acted through a tool; never replay
      // it or report its effects as rolled back after an abort.
      mark.run(row.state === "running" ? "uncertain" : "canceled", row.id);
      active.get(row.id)?.controller.abort();
    }
    if (job.command === "/clear" || job.command === "/new") {
      delivery.clear(job);
      permissions.clear(job.thread);
      db.prepare("DELETE FROM sessions WHERE thread=?").run(job.thread);
      return (
        "Conversation cleared. Your next message starts a new session." +
        (stoppingTurn ? " Work the stopped turn already did may remain." : "")
      );
    }
    if (stoppingTurn) return "Stopped. Work the turn already did may remain.";
    return prior.length ? "Stopped." : "Nothing is running.";
  }

  // Approval questions go to the conversation the turn is answering. Agent
  // tasks and sponsored group members have nobody who can approve.
  function permissionFor(job, route, turnSignal) {
    if (
      route.channel === "a2a" ||
      route.channel === "external" ||
      route.companion ||
      route.sponsored
    )
      return Object.assign(async () => "reject", { unattended: true });
    let prompts = 0;
    return ({ key, summary }, hostSignal) =>
      permissions.ask({
        conversation: askedIn(route),
        session: job.thread,
        actor: route.sender,
        mention: Boolean(route.group && route.groupReplyMode === "mention"),
        key,
        summary,
        signal: hostSignal
          ? AbortSignal.any([turnSignal, hostSignal])
          : turnSignal,
        timeoutMs:
          (config.permissionTimeoutS ?? DEFAULT_PERMISSION_TIMEOUT_S) * 1000,
        send: (prompt) =>
          reply(
            route,
            // The person must see the request exactly as it will run.
            boundedReply(route.channel, prompt, { verbatim: true }),
            digest(job.id, "permission", ++prompts),
            client,
            identity,
          ),
      });
  }

  async function processJob(job, signal) {
    const route = JSON.parse(job.payload);
    // Retries survive service restarts; the current owner's routing policy, not
    // a previous process's saved copy, must authorize delayed work and replies.
    const allowedSenders = config.allowedSenders ?? [];
    const allowedRecipients = config.outbound?.allowedRecipients ?? [];
    const changedSenders =
      JSON.stringify(allowedSenders) !==
      JSON.stringify(route.allowedSenders ?? []);
    route.allowedSenders = allowedSenders;
    route.allowedRecipients = allowedRecipients;
    route.groupReplyMode = config.groupReplyMode ?? "auto";
    const matches = (list, value) =>
      list.some((entry) => entry.trim().toLowerCase() === value.toLowerCase());
    if (
      (route.channel === "slack" && !config.slackEnabled) ||
      (route.sponsored && config.companionResponseMode !== "relaxed") ||
      (route.channel !== "external" &&
        config.outbound?.approval === "allowlist" &&
        !allowedRecipients.length) ||
      (!route.sponsored &&
        route.channel !== "slack" &&
        allowedSenders.length &&
        !matches(allowedSenders, route.sender)) ||
      (route.channel === "a2a" &&
        allowedRecipients.length &&
        !allowedRecipients.includes(route.callerId) &&
        !matches(allowedRecipients, route.sender)) ||
      (job.state === "reply" &&
        route.companion?.activation &&
        changedSenders &&
        !(await beforeTurn(route, client, identity, { hasSession: true })))
    ) {
      mark.run("ignored", job.id);
      return;
    }
    if (job.state === "report") {
      await reportExternalFailure(route, client, identity);
      mark.run("failed", job.id);
      return;
    }
    let answer = job.answer;
    if (job.state === "queued") {
      const session = getSession.get(job.thread);
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
      const mediaWait = db
        .prepare("SELECT deadline FROM media_wait WHERE job=?")
        .get(job.id);
      if (mediaWait) {
        if (waitsForTranscript(route) && Date.now() < mediaWait.deadline) {
          db.prepare("UPDATE jobs SET due=? WHERE id=?").run(
            Math.min(mediaWait.deadline, Date.now() + 5_000),
            job.id,
          );
          return;
        }
        db.prepare("DELETE FROM media_wait WHERE job=?").run(job.id);
      }
      // Only reading the source back can show that a text is a group message.
      // A group never shares the sender's one-to-one session.
      if (route.group && route.person) {
        route.person = null;
        route.memories = [];
        route.thread = route.conversationThread;
        db.prepare(
          "UPDATE jobs SET thread=?, actor=?, payload=? WHERE id=?",
        ).run(route.thread, route.sender, JSON.stringify(route), job.id);
        return;
      }
      if (job.command && route.noControls) {
        mark.run("ignored", job.id);
        return;
      }
      if (job.command) {
        transaction(() => {
          answer = applyControl(job, route);
          saveAnswer.run(answer, JSON.stringify(route), job.id);
        });
        if (session && !getSession.get(job.thread))
          rmSync(pathFor(session.revision), { force: true });
      } else {
        route.contact = await describeSender(route, resolveContact);
        if (signal.aborted) return;
        if (route.group) route.memories = [];
        const notes = delivery.unread(job);
        route.deliveryContext = describeDelivery(notes);
        const file = pathFor(job.id);
        // A crash mid-turn never becomes the starting point for a retry.
        if (session) copyFileSync(pathFor(session.revision), file);
        else rmSync(file, { force: true });
        // A turn can act through its tools before Pi exits. Never replay it
        // from the pre-turn transcript after an interrupted process.
        if (
          route.channel !== "external" &&
          !db
            .prepare(
              "UPDATE jobs SET state='running' WHERE id=? AND state='queued'",
            )
            .run(job.id).changes
        )
          return;
        answer = await turn(
          turnConfig,
          route,
          file,
          signal,
          permissionFor(job, route, signal),
        );
        if (signal.aborted) return;
        if (route.channel === "a2a") parseA2AOutcome(answer);
        flush(file);
        flush(dir);
        transaction(() => {
          delivery.seen(notes);
          delete route.deliveryContext;
          delete route.contact;
          const who = actorOf(route);
          const actor = !session || session.actor === who ? who : null;
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
        result = await reply(
          route,
          boundedReply(
            route.channel,
            !job.command &&
              ["sms", "imessage", "whatsapp"].includes(route.channel)
              ? stripMarkdown(answer)
              : answer,
          ),
          job.id,
          client,
          identity,
        );
      } catch (error) {
        if (route.channel !== "a2a") throw error;
        db.prepare("UPDATE jobs SET state='uncertain' WHERE id=?").run(job.id);
        recordFailure(
          job.id,
          job.attempts + 1,
          failureCategory(error, "reply-delivery"),
        );
        return;
      }
    }
    transaction(() => {
      let state = result?.skipped ? "ignored" : "done";
      if (
        result?.id &&
        ["email", "sms", "imessage", "whatsapp"].includes(route.channel)
      ) {
        db.prepare(
          "INSERT OR REPLACE INTO outbound(channel,message,job) VALUES(?,?,?)",
        ).run(route.channel, result.id, job.id);
        delivery.bind(job.id, route.channel, result.id);
        state =
          db
            .prepare("SELECT state FROM notices WHERE channel=? AND message=?")
            .get(route.channel, result.id)?.state ?? "done";
      }
      mark.run(state, job.id);
    });
  }

  function recordFailure(id, attempt, category, detail) {
    db.prepare(
      "INSERT OR REPLACE INTO diagnostics(job, attempt, category) VALUES(?,?,?)",
    ).run(id, attempt, category);
    logger.error(
      "Inkbox Pi job failed:",
      id,
      "attempt",
      attempt,
      category,
      ...(detail ? [detail] : []),
    );
  }

  function retry(job, signal, error) {
    if (signal.aborted) return;
    const row = db
      .prepare("SELECT attempts,state FROM jobs WHERE id=?")
      .get(job.id);
    const { attempts } = row;
    let { state } = row;
    // Pi never accepted the prompt, so nothing can have run: retry as queued.
    if (state === "running" && error?.started === false) {
      db.prepare("UPDATE jobs SET state='queued' WHERE id=?").run(job.id);
      state = "queued";
    }
    const category = failureCategory(
      error,
      state === "reply" ? "reply-delivery" : "event-processing",
    );
    recordFailure(job.id, attempts + 1, category, error?.detail);
    if (state === "running") {
      if (JSON.parse(job.payload).channel === "a2a") {
        // Report the unsuccessful turn to the caller; task ownership and
        // current state are checked again before this transition is sent.
        saveAnswer.run(
          JSON.stringify({
            intent: "fail",
            text: "Pi could not complete this task.",
          }),
          job.payload,
          job.id,
        );
        return;
      }
      db.prepare("UPDATE jobs SET state='failed' WHERE id=?").run(job.id);
      logger.error("Inkbox Pi turn did not finish and was not rerun:", job.id);
      return;
    }
    const status = error?.statusCode;
    const permanent =
      Number.isInteger(status) &&
      status >= 400 &&
      status < 500 &&
      ![408, 409, 425, 429].includes(status);
    if (!permanent && attempts < RETRIES.length) {
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
    AND (NOT EXISTS(SELECT 1 FROM jobs earlier WHERE earlier.thread=j.thread AND earlier.state IN ${PENDING}
      AND ((j.command IS NOT NULL AND earlier.command IS NOT NULL AND earlier.rowid<j.rowid) OR
       (j.command IS NULL AND (earlier.command IS NOT NULL AND earlier.rowid<j.rowid OR
        earlier.command IS NULL AND (CASE WHEN j.sequence IS NOT NULL AND earlier.sequence IS NOT NULL AND j.sequence!=earlier.sequence
          THEN earlier.sequence<j.sequence ELSE earlier.rowid<j.rowid END))))))
    ORDER BY j.command IS NULL, j.rowid`);

  function schedule() {
    if (closed || paused) return;
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
          .catch((error) => retry(job, controller.signal, error))
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
    start() {
      paused = false;
      schedule();
    },
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
    lastFailure(eventId) {
      return (
        db
          .prepare(
            "SELECT category,attempt FROM diagnostics JOIN receipts ON diagnostics.job=receipts.job WHERE event=?",
          )
          .get(eventId) ?? null
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
        ).then(() => {
          db.close();
          owner.close();
        });
      }
      return closeTask;
    },
  };
}
