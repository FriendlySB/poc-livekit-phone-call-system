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

test("builds exactly the 6 ServeAI tools, each a FunctionTool", () => {
  const tools = createServeAiTools(makeStub(), IDS);
  assert.deepEqual(Object.keys(tools).sort(), [...TOOL_NAMES].sort());
  for (const name of TOOL_NAMES) {
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
