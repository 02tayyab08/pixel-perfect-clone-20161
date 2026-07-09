# (D) Fix plan — belt-and-suspenders against thought-part leakage

## What's happening now

`src/routes/api/query.ts` calls `ai.models.generateContentStream` with only `systemInstruction` + `tools`. No `thinkingConfig`. The stream loop reads `chunk.text` (aggregate getter) and forwards every non-empty string as a `delta`. Model is `gemini-2.5-flash`, which has thinking on by default.

Two failure modes are consistent with the "draft, then restated final answer" transcript:
1. The SDK's `chunk.text` getter concatenates text across all parts, including any part flagged `thought: true`.
2. Even if thought summaries are gated by `includeThoughts: true`, we're relying on that default rather than asserting it.

## Fix (two changes, both in `src/routes/api/query.ts`, inside the stream call and its consumer)

### 1. Explicitly set `thinkingConfig` on the request

Add to the `config` object passed to `generateContentStream`:

```ts
thinkingConfig: {
  includeThoughts: false,
  // Do NOT set thinkingBudget: 0 — that disables reasoning entirely
  // and can degrade answer quality on multi-fee-line disambiguation
  // questions, which is exactly the class we just hardened.
},
```

This asserts our intent instead of depending on defaults.

### 2. Replace `chunk.text` with per-part iteration that skips thought parts

Replace the delta emission block:

```ts
for await (const chunk of iter) {
  const parts = chunk.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    // Defense-in-depth: drop any part flagged as reasoning/thought,
    // regardless of thinkingConfig. The @google/genai Part type carries
    // an optional `thought?: boolean`.
    if ((part as { thought?: boolean }).thought) continue;
    const text = (part as { text?: string }).text ?? "";
    if (!text) continue;
    fullText += text;
    send({ type: "delta", text });
  }
  // grounding-metadata handling below stays unchanged
  const cand = chunk.candidates?.[0];
  const gm = cand?.groundingMetadata;
  // ...existing groundingChunks / groundingSupports logic unchanged...
}
```

Rationale for per-part iteration even with `includeThoughts: false`: it costs nothing, removes reliance on the SDK's aggregate getter behavior, and forward-protects against SDK upgrades or model-version changes that might start emitting thought parts.

## What I am NOT changing

- Not disabling thinking (`thinkingBudget: 0`) — the fee-disambiguation addendum benefits from reasoning; we only want the reasoning kept internal.
- Not touching the addendum, prompt, or model choice.
- Not touching the client SSE parser — it already only appends `delta.text` to the message.

## Verification steps (after you approve and I ship)

1. You re-run the exact (D) reproduction question: *"What is the exact price difference between an IFZA 'Visa Amendment' fee line and an 'Investor Visa Add-On' fee line?"*
2. Expected: single, non-duplicated answer citing both line items and the difference once.
3. If the duplication persists after this change, the source is not thought leakage and I'll instrument the raw part stream (log `parts.map(p => ({thought: p.thought, textLen: p.text?.length}))` per chunk) to see exactly what Gemini is sending — but I don't expect to need this.

## Files touched

- `src/routes/api/query.ts` — add `thinkingConfig`, switch delta loop to per-part iteration with thought filter.

No schema changes. No client changes. No addendum changes.
