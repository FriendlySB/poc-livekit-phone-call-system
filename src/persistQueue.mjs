/**
 * Serial persistence queue for ServeAI chat history (LiveKit agent worker).
 *
 * Robustness contract — this is the piece that guarantees, under fast transcript
 * bursts, that no turn is silently dropped and that turns land in conversation
 * order:
 *   - SINGLE promise chain  -> exactly one insert runs at a time (serial drainer).
 *   - SYNCHRONOUS enqueue    -> persist() appends to the tail and returns instantly,
 *                               capturing submission order; callers never await it,
 *                               so the audio pipeline is never blocked.
 *   - SEEDED with getChatId  -> the chatroom is pre-created WITH the caller's number
 *                               before any insert, so the first insert can't race a
 *                               second create (insertUser/BotMessage call getChatId
 *                               WITHOUT the number internally).
 *   - flush()                -> resolves once every step enqueued so far has run; the
 *                               worker awaits it on shutdown so the final turns aren't
 *                               lost when the caller hangs up.
 *
 * Errors are logged and swallowed per-step so one failed insert never stalls the
 * rest of the queue.
 *
 * @param {{getChatId:Function}} chatbotService - ServeAI persistence singleton.
 * @param {{chatflowId:string, callSid:string, callerNumber:string}} ids
 * @returns {{persist:(fn:()=>Promise<unknown>)=>void, flush:()=>Promise<unknown>}}
 */
export function createPersistQueue(chatbotService, { chatflowId, callSid, callerNumber }) {
  // Seed the chain with session pre-creation (tie chatroom to caller's number).
  let chain = chatbotService
    .getChatId(callSid, chatflowId, callerNumber)
    .then(() => {})
    .catch((e) => console.error("ServeAI session create failed:", e.message));

  const persist = (fn) => {
    chain = chain
      .then(fn)
      .catch((e) => console.error("ServeAI persist error:", e.message));
  };

  const flush = () => chain;

  return { persist, flush };
}
