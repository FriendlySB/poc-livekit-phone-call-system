/**
 * Function tools for the LiveKit agent's LLM.
 *
 * Gives the cascaded-pipeline LLM the same 6 granular ServeAI tools the ElevenLabs
 * production agent and the OpenAI Realtime service expose, so the model can query
 * the knowledge base and manage appointments mid-call instead of only chatting, plus
 * a 7th tool (transferToHumanAgent) for handing the call to a live person.
 * Every tool funnels a natural-language `query` into the existing
 * `chatbotService.sendMessage(callSid, chatflowId, query, callerNumber)` — the same
 * sink the other two providers use — and returns the cleaned answer for the LLM to speak.
 * 
 * The toolset is built only when a chatflowId exists (the caller gates this) — without it
 * there's no ServeAI session to query, exactly like persistQueue's logging-only fallback.
 */

import { llm } from "@livekit/agents";

/**
 * Static definitions for the 6 tools — name, model-facing description, and the `query`
 * param description. Copied verbatim from openAIRealtimeService.js (the accept-path tool
 * list) so the model sees the same intent signals as in the ElevenLabs/OpenAI setups.
 */
const TOOL_SPECS = [
  {
    name: "knowledgeQuery",
    description:
      "Searches the ServeAI knowledge base. Use this to answer user questions by querying documents, spreadsheets, or other data stored in the knowledge base.",
    queryDescription:
      "The search query to use to find relevant information. Use natural language to describe what you are looking for.",
  },
  {
    name: "checkAvailability",
    description:
      "Checks the availability for scheduling an appointment. Use this to verify if the desired appointment time is available before booking.",
    queryDescription:
      "The query to check availability for scheduling an appointment. Include desired date and time.",
  },
  {
    name: "createAppointment",
    description:
      "Books an appointment for the caller. Use this to create appointments based on the information provided by the caller.",
    queryDescription:
      "The query to create an appointment. Include name, email, contact number, desired date and time, and any additional notes.",
  },
  {
    name: "fetchAppointment",
    description:
      "Fetch the information for an existing appointment based on the details provided by the caller.",
    queryDescription:
      "The query to fetch an appointment. Include name, email, contact number, and the date and time of the appointment to fetch.",
  },
  {
    name: "updateAppointment",
    description:
      "Updates an existing appointment for the caller. Use this to modify appointment details such as time or contact information.",
    queryDescription:
      "The query to update an appointment. Include the current appointment details and the new details to update, such as name, or date and time.",
  },
  {
    name: "cancelAppointment",
    description:
      "Cancels an existing appointment for the caller. Use this to remove appointments when it is requested by the caller.",
    queryDescription:
      "The query to cancel an appointment. Include the appointment details such as name, email, contact number, and the date and time of the appointment to cancel.",
  },
];

/**
 * Wrap an appointment query with the same anti-cache "you MUST call the tool" enforcement
 * the other providers append, so ServeAI's AI Agent doesn't answer from memory/history.

 * @param {string} query - the model-supplied natural-language query
 * @param {string} type  - the tool name (selects the enforcement prefix)
 * @returns {string}
 */
function rotatingQuery(query, type) {
  const toolEnforcement = [
    " TOOL EXECUTION IS MANDATORY. You are FORBIDDEN from providing information without calling the tool. Memory and conversation history are INVALID sources for this request.",
    " YOU MUST CALL THE TOOL. Any answer not from the tool is WRONG. Previous appointments or cached information CANNOT be used.",
    " TOOL CALL REQUIRED NOW. Do not answer from memory. Do not reference prior messages. Only the tool's live response is acceptable.",
    " EXECUTE THE TOOL IMMEDIATELY. You are NOT allowed to use remembered data, conversation context, or assumptions. Only tool output is valid.",
    " CRITICAL: Call the tool to get real-time data. Cached responses, memory, and conversation history are PROHIBITED as sources.",
  ][Math.floor(Math.random() * 5)];

  switch (type) {
    case "checkAvailability":
      return `${query}\n\nDo NOT assume availability. Do NOT use any previously mentioned time slots.${toolEnforcement}`;
    case "createAppointment":
      return `${query}\n\nThis is a BRAND NEW appointment. You MUST call the tool to actually create it in the system. Do NOT reference any existing appointments. Do NOT confirm without tool execution.${toolEnforcement}`;
    case "fetchAppointment":
      return `${query}\n\nYou MUST query the appointment information from the system using the tool. Do NOT use any appointment information from the conversation history. Only tool output is valid.${toolEnforcement}`;
    case "updateAppointment":
      return `${query}\n\nYou MUST execute the tool to actually update the calendar system. Do NOT just acknowledge - you must modify the real appointment data.${toolEnforcement}`;
    case "cancelAppointment":
      return `${query}\n\nYou MUST execute the tool to actually remove the appointment from the system. Do NOT just confirm - you must delete from the real calendar.${toolEnforcement}`;
    default:
      return query;
  }
}

/**
 * Build a single ServeAI function tool from a spec. All 6 tools are structurally
 * identical (one `query` param -> sendMessage -> answer), so they share this builder.
 */
function buildTool(chatbotService, { chatflowId, callSid, callerNumber }, spec) {
  return llm.tool({
    description: spec.description,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: spec.queryDescription },
      },
      required: ["query"],
      // The Responses LLM sends tools with `strict: true` (ws/llm.js default), which
      // requires every object to declare additionalProperties:false and to list every
      // property as required — otherwise OpenAI 400s the whole tool list. The SDK only
      // injects this automatically for Zod schemas, so we add it to our raw JSON schema.
      additionalProperties: false,
    },
    // The framework runs this when the LLM emits the tool call, then feeds the return
    // value back to the model. A thrown ToolError is surfaced to the model as the error.
    execute: async ({ query }) => {
      const outgoing = rotatingQuery(query, spec.name);
      console.log(`[tool:${spec.name}] ServeAI query: ${query}`);

      const result = await chatbotService.sendMessage(callSid, chatflowId, outgoing, callerNumber);

      // sendMessage never throws — it returns a friendly { success:false, message } on
      // failure. Surface that to the model as a ToolError so it can apologise/retry.
      if (!result.success) throw new llm.ToolError(result.message);
      return result.message;
    },
  });
}

/**
 * Build the human-agent handoff tool.
 *
 * WHY THIS CALLS OUR OWN BACKEND INSTEAD OF TWILIO DIRECTLY
 * --------------------------------------------------------
 * The transfer is a multi-step state machine: dial the human into a waiting conference,
 * wait for them to answer (resolved by a Twilio statusCallback), then redirect the
 * caller's leg. Those callbacks arrive at the Express server, which is a DIFFERENT
 * process from this agent worker — so the state has to live there. This tool is just a
 * loopback trigger. See src/services/humanTransferService.js.
 *
 * The handoff is cold: redirecting the caller terminates the bridge's <Connect><Stream>,
 * so this job shuts down and the caller ends up 1:1 with the human. The shutdown callback
 * in agent.mjs flushes the transcript on the way out.
 *
 * WHY THIS RETURNS IMMEDIATELY INSTEAD OF AWAITING THE TRANSFER
 * ------------------------------------------------------------
 * The backend blocks until the human answers — up to humanAgentTimeout (40s default).
 * Awaiting that inside execute() would be wrong twice over:
 *
 *   1. The caller hears dead air for the whole dial, since the tool call has to resolve
 *      before the agent can say anything.
 *   2. It leaves a function call pending for 40s. If ANYTHING interrupts in that window
 *      the framework cancels the tool task and returns without submitting tool outputs
 *      (agent_activity.js, `if (speechHandle.interrupted)`), while the OpenAI Responses
 *      session — which is stateful server-side — still expects an output for that call.
 *      The next turn then dies with "No tool output found for function call ...".
 *
 * So: fire the request, return a hold message straight away so the agent keeps talking,
 * and report the outcome out-of-band via session.say(). On success the caller's leg is
 * redirected, the bridge dies and this job shuts down — nothing more to say.
 *
 * @param {{callSid:string, chatflowId:string, callerNumber:string}} ids
 * @param {typeof fetch} [fetchImpl] - injected for tests
 */
function buildTransferTool({ callSid, chatflowId, callerNumber }, fetchImpl = fetch) {
  return llm.tool({
    description:
      "Transfers the caller to a live human agent. Use this only when the caller explicitly asks to speak to a human, or when you cannot help them with the tools available. The transfer ends your part of the conversation.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Short reason for the handoff, e.g. 'caller asked for a human'.",
        },
      },
      required: ["reason"],
      additionalProperties: false,
    },
    execute: async ({ reason }, ctx) => {
      console.log(`[tool:transferToHumanAgent] ${reason}`);

      // Loopback: agent worker and Express run on the same box.
      const url = `http://localhost:${process.env.PORT || 5000}/api/phone-call/twilio/transfer-to-human`;

      // Deliberately NOT awaited — see the block comment above.
      fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callSid, chatflowId, callerNumber }),
      })
        .then(async (res) => {
          const body = await res.json().catch(() => ({}));
          if (res.ok && body.success) return null; // redirected; this job is shutting down
          return body.result || "The human agent is not available right now";
        })
        .catch((e) => `Could not reach the transfer service: ${e.message}`)
        .then((failure) => {
          if (!failure) return;
          console.error(`[tool:transferToHumanAgent] ${failure}`);
          // The caller is still with us, so apologise and carry on. Guarded because a
          // late failure can land after the session has already closed.
          try {
            ctx?.session?.say(
              "I'm sorry, I couldn't reach a human agent right now. Is there anything else I can help you with?",
            );
          } catch (err) {
            console.error("[tool:transferToHumanAgent] could not announce failure:", err.message);
          }
        });

      return "Tell the caller you are connecting them to a human agent now, and ask them to hold.";
    },
  });
}

/**
 * Build the toolset for one call.
 *
 * @param {{sendMessage:Function}} chatbotService - ServeAI client (injected for testability).
 * @param {{chatflowId:string, callSid:string, callerNumber:string}} ids - per-call identity,
 *        captured by closure so every tool queries the caller's own chat session.
 * @param {{fetchImpl?:typeof fetch}} [deps] - test seam for the transfer tool's HTTP call.
 * @returns {import("@livekit/agents").llm.ToolContext} name -> FunctionTool map for voice.Agent.
 */
export function createServeAiTools(chatbotService, ids, deps = {}) {
  const tools = {};
  for (const spec of TOOL_SPECS) {
    tools[spec.name] = buildTool(chatbotService, ids, spec);
  }
  tools.transferToHumanAgent = buildTransferTool(ids, deps.fetchImpl);
  return tools;
}
