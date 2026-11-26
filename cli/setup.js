import { statSync } from "node:fs";
import { resolve } from "node:path";
import { IncomingCallAction, Inkbox } from "@inkbox/sdk";
import {
  normalizeOrigin,
  readProfile,
  saveProfile,
  sharedSigningKey,
  signingKeyDigest,
} from "./config.js";
import { problem } from "./errors.js";

export async function verifiedIdentity(client, requested) {
  const principal = await client.whoami();
  if (
    principal.authType !== "api_key" ||
    principal.authSubtype !== "api_key.agent_scoped.claimed"
  ) {
    throw problem(
      "Use a claimed agent-scoped API key, or use setup to connect an existing account.",
    );
  }
  const identities = await client.listIdentities();
  if (
    identities.length !== 1 ||
    (requested && identities[0].agentHandle !== requested)
  ) {
    throw problem("The API key does not match the selected identity.");
  }
  return client.getIdentity(identities[0].agentHandle);
}

// The API exposes the creation time, not the secret. Reject a known stale
// saved key without rotating it or assuming a newly supplied key is old.
export async function signingKeyReady(config, identity) {
  if (!config.signingKey) return false;
  const status = await identity.getSigningKeyStatus();
  if (!status.configured) return false;
  const saved = readProfile(config.home);
  const usingSavedKey =
    saved.baseUrl === config.baseUrl &&
    saved.identity === identity.agentHandle &&
    saved.signingKey === config.signingKey;
  return (
    !usingSavedKey ||
    !saved.signingKeyCreatedAt ||
    !status.createdAt ||
    new Date(status.createdAt).toISOString() === saved.signingKeyCreatedAt
  );
}

/** @param {string} apiKey @param {string | undefined} baseUrl @param {string} [userAgentPrefix] */
export function createClient(apiKey, baseUrl, userAgentPrefix = undefined) {
  const client = new Inkbox({ apiKey, baseUrl, userAgentPrefix });
  // The SDK may try an optional configured vault key during construction.
  // Messaging must still work if that key is stale; vault tools unlock explicitly.
  void client.ready().catch(() => {});
  return client;
}

async function resolveKey(options, previous, io, clientFor) {
  const { baseUrl, requested, key } = options;
  const client = clientFor(key, baseUrl);
  let info = await client.whoami();
  if (info.authSubtype === "api_key.agent_scoped.unclaimed" && io) {
    for (;;) {
      const code = await io.ask(
        "Verification code from your email (or 'resend')",
      );
      if (!code)
        throw problem("Verification not completed. Run setup to resume.");
      if (code.toLowerCase() === "resend") {
        await Inkbox.resendSignupVerification(key, { baseUrl });
        continue;
      }
      try {
        await Inkbox.verifySignup(key, { verificationCode: code }, { baseUrl });
        break;
      } catch (error) {
        if (error.statusCode !== 400 && error.statusCode !== 422) throw error;
        io.print(
          "Verification was not accepted; try again or request a new code.",
        );
      }
    }
    info = await client.whoami();
  }
  if (
    info.authType !== "api_key" ||
    info.authSubtype !== "api_key.admin_scoped"
  ) {
    return { key, identity: await verifiedIdentity(client, requested) };
  }
  let handle = requested;
  if (!handle && io) {
    const list = await client.listIdentities();
    io.print(
      "Available identities: " +
        (list.map((i) => i.agentHandle).join(", ") || "(none)"),
    );
    handle = (
      await io.ask("Choose an existing handle, or enter +handle to create one")
    ).replace(/^@/, "");
    if (handle.startsWith("+") && handle.length > 1)
      handle = (await client.createIdentity(handle.slice(1))).agentHandle;
  }
  if (!handle)
    throw problem("An admin key requires an explicit identity handle.");
  const selected = await client.getIdentity(handle);
  if (
    previous.apiKey &&
    previous.identity === handle &&
    previous.baseUrl === baseUrl
  ) {
    const reused = await verifiedIdentity(
      clientFor(previous.apiKey, baseUrl),
      handle,
    ).catch(() => undefined);
    if (reused && reused.id === selected.id)
      return { key: previous.apiKey, identity: reused };
  }
  const minted = await client.apiKeys.create({
    label: "Pi gateway - " + handle,
    scopedIdentityId: selected.id,
  });
  if (!minted.apiKey) throw problem("No scoped API key was returned.");
  return {
    key: minted.apiKey,
    identity: await verifiedIdentity(clientFor(minted.apiKey, baseUrl), handle),
  };
}

// Phone calls to the identity are answered by Inkbox's call agent; the gateway
// receives the transcript when a call ends.
async function answerCalls(identity) {
  const current = await identity.getIncomingCallAction();
  if (current.incomingCallAction === IncomingCallAction.HOSTED_AGENT) return;
  await identity.setIncomingCallAction({
    incomingCallAction: IncomingCallAction.HOSTED_AGENT,
  });
}

export async function configure(config, options, io, clientFor = createClient) {
  const previous = readProfile(config.home);
  const baseUrl = normalizeOrigin(options.baseUrl || config.baseUrl);
  const sameOrigin = baseUrl === config.baseUrl;
  let key = options.key || (sameOrigin && config.apiKey);
  if (options.replaceKey) {
    if (!io)
      throw problem(
        "Key replacement needs an interactive terminal or bootstrap --api-key-stdin.",
      );
    key = await io.secret("Paste the replacement Inkbox API key");
    if (!key)
      throw problem(
        "No replacement key entered. Your existing profile was not changed.",
      );
  }
  let requested = (
    options.identity ||
    (sameOrigin && config.identity) ||
    ""
  ).replace(/^@/, "");
  const projectDir =
    io && !options.projectDir
      ? await io.ask("Project directory [" + config.projectDirectory + "]")
      : options.projectDir;
  const projectDirectory = resolve(projectDir || config.projectDirectory);
  if (!statSync(projectDirectory, { throwIfNoEntry: false })?.isDirectory()) {
    throw problem("The project directory does not exist.");
  }
  if (!key && io) {
    if (await io.confirm("Create a new Inkbox identity by email?")) {
      const humanEmail = await io.ask("Your email address");
      const agentHandle = requested || (await io.ask("Desired agent handle"));
      const signup = await Inkbox.signup(
        {
          humanEmail,
          agentHandle,
          harness: "pi",
          noteToHuman: "Connect your Pi agent to Inkbox.",
        },
        { baseUrl },
      );
      key = signup.apiKey;
      requested = signup.agentHandle;
      // Checkpoint immediately so a cancelled verification can be resumed.
      saveProfile(config.home, {
        baseUrl,
        apiKey: key,
        identity: requested,
        projectDirectory,
      });
      io.print("Check your email to verify the new identity.");
    } else {
      key = await io.secret("Paste your Inkbox API key");
    }
  }
  if (!key)
    throw problem("Supply INKBOX_API_KEY or use bootstrap --api-key-stdin.");
  const result = await resolveKey(
    { key, requested, baseUrl },
    previous,
    io,
    clientFor,
  );
  const identity = result.identity;
  const sameProfile =
    previous.baseUrl === baseUrl && previous.identity === identity.agentHandle;
  const profile = {
    ...(sameProfile ? previous : {}),
    baseUrl,
    apiKey: result.key,
    identity: identity.agentHandle,
    projectDirectory,
    piBin: config.piBin,
  };
  // Persist a freshly scoped credential before any optional steps. Never save an admin key.
  saveProfile(config.home, profile);
  if (io) {
    io.print(
      "Connected @" +
        identity.agentHandle +
        (identity.emailAddress ? ": " + identity.emailAddress : ""),
    );
    if (!identity.imessageEnabled && (await io.confirm("Enable iMessage?"))) {
      try {
        await identity.update({ imessageEnabled: true });
      } catch {
        io.print("iMessage could not be enabled. You can retry with setup.");
      }
    }
    if (identity.imessageEnabled) {
      try {
        const router = await clientFor(
          result.key,
          baseUrl,
        ).imessages.getTriageNumber();
        if (router.number)
          io.print(
            "iMessage: text " +
              (router.connectCommand || "connect @" + identity.agentHandle) +
              " to " +
              router.number,
          );
      } catch {
        io.print(
          "Use the Inkbox iMessage connection instructions for this identity.",
        );
      }
    }
    if (
      !identity.phoneNumber &&
      (await io.confirm("Provision a dedicated SMS number (paid plans)?"))
    ) {
      try {
        await identity.provisionPhoneNumber();
      } catch {
        io.print(
          "No number provisioned. Check plan availability or retry later.",
        );
      }
    }
    if (identity.phoneNumber)
      io.print(
        "To opt in to SMS, text START to " + identity.phoneNumber.number,
      );
    if (
      (identity.phoneNumber || identity.imessageEnabled) &&
      (await io.confirm(
        "Let Inkbox's call agent answer phone calls to this agent?",
        true,
      ))
    ) {
      try {
        await answerCalls(identity);
        io.print(
          "Phone calls will be answered by Inkbox's call agent. Pi receives the transcript when a call ends.",
        );
      } catch {
        io.print(
          "Call answering could not be set up. You can retry with setup.",
        );
      }
    }
    io.print(
      "Pi uses Inkbox tools to send email and messages, place calls, read history and manage contacts. Trusting these tools skips the approval question before each Inkbox send; Pi's own command and file approvals are unchanged.",
    );
    profile.autoApproveInkboxTools = await io.confirm(
      "Allow this agent to run Inkbox tools without asking each time?",
      profile.autoApproveInkboxTools !== false,
    );
    io.print(
      profile.autoApproveInkboxTools
        ? "Inkbox tools will run without asking."
        : "Pi will ask before each Inkbox send.",
    );
    io.print(
      "YOLO mode runs every tool, including shell commands and file edits, without asking. Anyone who can message this agent can then run commands on this machine.",
    );
    profile.yolo = await io.confirm(
      "Run every tool without asking (YOLO)?",
      profile.yolo === true,
    );
  } else {
    // Unattended setup trusts the Inkbox tools unless a choice was already saved.
    if (typeof profile.autoApproveInkboxTools !== "boolean")
      profile.autoApproveInkboxTools = true;
    if (identity.phoneNumber || identity.imessageEnabled)
      await answerCalls(identity).catch(() => {});
  }
  saveProfile(config.home, profile);

  const status = await identity.getSigningKeyStatus();
  const rotated =
    sameProfile &&
    status.createdAt &&
    previous.signingKeyCreatedAt &&
    new Date(status.createdAt).toISOString() !== previous.signingKeyCreatedAt;
  if (rotated && previous.signingKey)
    profile.invalidSigningKeyDigest = signingKeyDigest(previous.signingKey);
  const usable = (candidate) =>
    candidate &&
    signingKeyDigest(candidate) !== profile.invalidSigningKeyDigest;
  let signingKey = [
    options.signingKey,
    sameProfile && previous.signingKey,
    sharedSigningKey(baseUrl, identity.agentHandle),
  ].find(usable);
  if (status.configured && !signingKey && io && !options.rotate) {
    const entered = await io.secret(
      "Existing webhook signing key (leave empty to skip the gateway)",
    );
    if (usable(entered)) signingKey = entered;
  }
  if (status.configured && !signingKey && !options.rotate) {
    delete profile.signingKey;
    delete profile.signingKeyCreatedAt;
    saveProfile(config.home, profile);
    return { identity: identity.agentHandle, ready: false };
  }
  let createdAt = status.createdAt;
  if (!status.configured || options.rotate) {
    const created = await identity.createSigningKey();
    signingKey = created.signingKey;
    createdAt = created.createdAt;
  }
  if (!signingKey) throw problem("No webhook signing key was returned.");
  profile.signingKey = signingKey;
  if (createdAt)
    profile.signingKeyCreatedAt = new Date(createdAt).toISOString();
  saveProfile(config.home, profile);
  return { identity: identity.agentHandle, ready: true };
}
