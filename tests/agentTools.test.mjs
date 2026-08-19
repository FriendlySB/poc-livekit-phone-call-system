/**
 * Unit tests for the ServeAI tool factory (src/agentTools.mjs).
 *
 * These assert the wiring + behavior of the 6 tools without any network: chatbotService
 * is a stub that records its calls, so we verify the tools are built correctly, call
 * sendMessage with the right (callSid, chatflowId, query, callerNumber), apply the
 * anti-cache enforcement to the appointment tools, and surface failures as ToolError.
 *
 * Run: node --test tests/agentTools.test.mjs
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { llm, initializeLogger } from "@livekit/agents";
import { createServeAiTools } from "../src/agentTools.mjs";

// Match agentProviders.test.mjs — some @livekit constructors grab a logger eagerly.
before(() => initializeLogger({ pretty: false, level: "silent" }));

const IDS = { chatflowId: "cf_123", callSid: "CA_test", callerNumber: "+60123456789" };

// Build a stub chatbotService whose sendMessage records its args and returns `reply`.
function makeStub(reply = { success: true, message: "stub answer" }) {
  const calls = [];
  return {
    calls,
    sendMessage: async (...args) => {
      calls.push(args);
      return reply;
    },
  };
}

const TOOL_NAMES = [
  "knowledgeQuery",
  "checkAvailability",
  "createAppointment",
  "fetchAppointment",
  "updateAppointment",
  "cancelAppointment",
];

test("builds the 6 ServeAI tools plus the human handoff, each a FunctionTool", () => {
  const tools = createServeAiTools(makeStub(), IDS);
  assert.deepEqual(Object.keys(tools).sort(), [...TOOL_NAMES, "transferToHumanAgent"].sort());
  for (const name of [...TOOL_NAMES, "transferToHumanAgent"]) {
    assert.ok(llm.isFunctionTool(tools[name]), `${name} should be a FunctionTool`);
  }
});

test("schemas are OpenAI strict-mode compliant (additionalProperties:false)", () => {
  // The Responses LLM sends tools with strict:true; without this the API 400s the
  // whole tool list. Guards against regressing the raw-JSON-schema fix offline, since
  // these tests can't reach OpenAI.
  const tools = createServeAiTools(makeStub(), IDS);
  for (const name of TOOL_NAMES) {
    const { parameters } = tools[name];
    assert.equal(parameters.additionalProperties, false, `${name} needs additionalProperties:false`);
    assert.deepEqual(parameters.required, ["query"], `${name} must require its only property`);
  }
});

test("knowledgeQuery: sends the raw query and returns the answer", async () => {
  const stub = makeStub({ success: true, message: "We open at 9am." });
  const tools = createServeAiTools(stub, IDS);

  const out = await tools.knowledgeQuery.execute({ query: "what are your hours?" }, {});

  assert.equal(out, "We open at 9am.");
  assert.equal(stub.calls.length, 1);
  const [callSid, chatflowId, outgoing, callerNumber] = stub.calls[0];
  assert.equal(callSid, IDS.callSid);
  assert.equal(chatflowId, IDS.chatflowId);
  assert.equal(callerNumber, IDS.callerNumber);
  // knowledgeQuery is NOT wrapped — the query reaches ServeAI verbatim.
  assert.equal(outgoing, "what are your hours?");
});

test("createAppointment: wraps the query with the enforcement prefix (parity)", async () => {
  const stub = makeStub();
  const tools = createServeAiTools(stub, IDS);

  await tools.createAppointment.execute({ query: "book John for Friday 3pm" }, {});

  const outgoing = stub.calls[0][2];
  // Original text is preserved...
  assert.ok(outgoing.includes("book John for Friday 3pm"));
  // ...plus the deterministic per-type prefix and a mandatory-tool enforcement line.
  assert.ok(outgoing.includes("BRAND NEW appointment"));
  assert.ok(/MUST|MANDATORY|REQUIRED|IMMEDIATELY|CRITICAL/.test(outgoing));
});

test("failure from ServeAI surfaces as a ToolError", async () => {
  const stub = makeStub({ success: false, message: "knowledge base is down" });
  const tools = createServeAiTools(stub, IDS);

  await assert.rejects(
    () => tools.knowledgeQuery.execute({ query: "anything" }, {}),
    (err) => {
      assert.ok(err instanceof llm.ToolError, "should be a ToolError");
      assert.equal(err.message, "knowledge base is down");
      return true;
    }
  );
});

// --- transferToHumanAgent -------------------------------------------------------------
// The tool is a loopback trigger: the real state machine lives in Express (see
// humanTransferService), so all this must do is POST the call identity and hand the agent
// something to say. fetch is injected so nothing leaves the process.
//
// It must NOT await the transfer. The backend blocks until the human answers (up to 40s);
// awaiting that leaves a function call pending, and any interruption in that window makes
// the framework cancel the tool without submitting its output — after which the stateful
// OpenAI Responses session 400s with "No tool output found for function call ...".

/** Record calls and reply with a canned { status, body }, resolving after `delayMs`. */
function makeFetchStub(status, body, delayMs = 0) {
  const calls = [];
  return {
    calls,
    fetchImpl: (url, init) => {
      calls.push({ url, init });
      return new Promise((resolve) =>
        setTimeout(
          () => resolve({ ok: status >= 200 && status < 300, status, json: async () => body }),
          delayMs,
        ),
      );
    },
  };
}

/** Minimal AgentSession stand-in — the tool reports late failures through say(). */
function makeCtx() {
  const said = [];
  return { said, ctx: { session: { say: (text) => said.push(text) } } };
}

/** Let the tool's detached promise chain settle. */
const settle = () => new Promise((r) => setTimeout(r, 20));

test("transferToHumanAgent: posts the call identity the backend needs", async () => {
  const f = makeFetchStub(200, { success: true, result: "transferred" });
  const tools = createServeAiTools(makeStub(), IDS, { fetchImpl: f.fetchImpl });

  const out = await tools.transferToHumanAgent.execute({ reason: "caller asked for a human" }, makeCtx().ctx);

  // Returns something for the agent to SAY, not the backend's result — the transfer is
  // still in flight at this point.
  assert.match(out, /connecting/i);
  assert.equal(f.calls.length, 1);

  const { url, init } = f.calls[0];
  // Loopback, not HOST — agent worker and Express are on the same box.
  assert.match(url, /^http:\/\/localhost:\d+\/api\/phone-call\/twilio\/transfer-to-human$/);
  assert.equal(init.method, "POST");

  // callerNumber matters: humanTransferService seeds the ServeAI chatroom with it, and an
  // unseeded seed would split the transcript into a second chatroom.
  assert.deepEqual(JSON.parse(init.body), {
    callSid: IDS.callSid,
    chatflowId: IDS.chatflowId,
    callerNumber: IDS.callerNumber,
  });
});

test("transferToHumanAgent: returns BEFORE the backend responds", async () => {
  // The regression guard for the 400. A 300ms backend must not hold the tool call open.
  const f = makeFetchStub(200, { success: true, result: "transferred" }, 300);
  const tools = createServeAiTools(makeStub(), IDS, { fetchImpl: f.fetchImpl });

  const started = Date.now();
  await tools.transferToHumanAgent.execute({ reason: "escalation" }, makeCtx().ctx);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 100, `tool should return immediately, took ${elapsed}ms`);
  assert.equal(f.calls.length, 1, "but the request must still have been sent");
});

test("transferToHumanAgent: a no-answer is announced to the caller, not thrown", async () => {
  const f = makeFetchStub(409, { success: false, result: "The human agent did not answer" });
  const { said, ctx } = makeCtx();
  const tools = createServeAiTools(makeStub(), IDS, { fetchImpl: f.fetchImpl });

  // Must not reject — the tool already returned, so there is no call left to fail.
  await tools.transferToHumanAgent.execute({ reason: "escalation" }, ctx);
  await settle();

  assert.equal(said.length, 1, "the caller must be told the handoff failed");
  assert.match(said[0], /couldn't reach a human agent/i);
});

test("transferToHumanAgent: an unreachable backend is announced too, not a crash", async () => {
  const { said, ctx } = makeCtx();
  const tools = createServeAiTools(makeStub(), IDS, {
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });

  await tools.transferToHumanAgent.execute({ reason: "escalation" }, ctx);
  await settle();

  assert.equal(said.length, 1);
});

test("transferToHumanAgent: says nothing on success — the job is shutting down", async () => {
  const f = makeFetchStub(200, { success: true, result: "transferred" });
  const { said, ctx } = makeCtx();
  const tools = createServeAiTools(makeStub(), IDS, { fetchImpl: f.fetchImpl });

  await tools.transferToHumanAgent.execute({ reason: "escalation" }, ctx);
  await settle();

  // The caller's leg was redirected, so the bridge is gone and so is this session.
  assert.deepEqual(said, []);
});

test("transferToHumanAgent: a closed session doesn't crash the late failure path", async () => {
  const f = makeFetchStub(409, { success: false, result: "nope" });
  const tools = createServeAiTools(makeStub(), IDS, { fetchImpl: f.fetchImpl });

  // No ctx at all, and a ctx whose say() throws — both must be survivable.
  await tools.transferToHumanAgent.execute({ reason: "escalation" }, undefined);
  await tools.transferToHumanAgent.execute(
    { reason: "escalation" },
    { session: { say: () => { throw new Error("session closed"); } } },
  );
  await settle();
});
