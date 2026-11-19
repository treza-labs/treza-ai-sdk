/** The tools against a scripted Treza: quote, cap, start once, wait, report. */
import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { TrezaClient, TrezaError, trezaTools } from "../src/index.js";

type Reply = [number, Record<string, unknown>];

function fakeTreza(answers: Record<string, Reply[]>) {
  const calls: { tool: string; args: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const tool = String(url).split("/").pop()!;
    calls.push({ tool, args: JSON.parse(String(init?.body ?? "{}")), headers: init?.headers as Record<string, string> });
    const next = answers[tool]?.shift();
    if (!next) throw new Error(`no scripted answer for ${tool}`);
    return new Response(JSON.stringify(next[1]), { status: next[0] });
  }) as typeof fetch;
  const client = new TrezaClient({ apiKey: "treza_live_test", fetch: fetchFn, sleep: async () => undefined });
  return { client, calls, asked: (tool: string) => calls.filter((c) => c.tool === tool).map((c) => c.args) };
}

const QUOTE = { pipelineId: "pipeline_1", quoteId: "q1", estimatedChargeUsd: 0.28, sufficient: true, model: { id: "google/veo-3.1-lite" } };
const DONE = { status: "success", outputs: { video: "https://media.trezalabs.com/v.mp4" }, durationMs: 56000 };
const ctx = { toolCallId: "t1", messages: [] } as never;

describe("trezaTools", () => {
  it("quotes, starts once and reports a video", async () => {
    const fake = fakeTreza({ make_video: [[200, QUOTE]], run_pipeline: [[200, { runId: "r1" }]], get_run: [[200, DONE]] });
    const tools = trezaTools({ client: fake.client });
    const out = await tools.treza_generate_video.execute!({ prompt: "a fox runs", aspectRatio: "9:16", durationSec: 4 }, ctx);
    expect(out).toMatchObject({
      url: "https://media.trezalabs.com/v.mp4",
      status: "success",
      finished: true,
      price_usd: 0.28,
      model: "google/veo-3.1-lite",
      render_seconds: 56,
      run_id: "r1",
      pipeline_id: "pipeline_1",
    });
    // No cap set, so none is sent.
    expect(fake.asked("make_video")).toEqual([{ prompt: "a fox runs", aspectRatio: "9:16", durationSec: 4 }]);
    expect(fake.asked("run_pipeline")).toEqual([{ pipelineId: "pipeline_1", quoteId: "q1" }]);
    expect(fake.calls[0]!.headers["User-Agent"]).toMatch(/^treza-ai-sdk\//);
    expect(fake.calls[0]!.headers.Authorization).toBe("Bearer treza_live_test");
  });

  it("over the cap goes back to the model and starts nothing", async () => {
    const fake = fakeTreza({ make_video: [[200, QUOTE]] });
    const out = await trezaTools({ client: fake.client, maxCostUsd: 0.1 }).treza_generate_video.execute!({ prompt: "a fox runs" }, ctx);
    expect(out).toMatchObject({ code: "OverBudget" });
    expect((out as { error: string }).error).toContain("over the Max cost of $0.10");
    expect(fake.asked("run_pipeline")).toEqual([]);
    expect(fake.asked("make_video")[0]!.maxPriceUsd).toBe(0.1);
  });

  it("a refusal can throw", async () => {
    const fake = fakeTreza({ make_video: [[200, QUOTE]] });
    const tools = trezaTools({ client: fake.client, maxCostUsd: 0.1, throwOnRefusal: true });
    await expect(tools.treza_generate_video.execute!({ prompt: "a fox runs" }, ctx)).rejects.toBeInstanceOf(TrezaError);
  });

  it("a low balance starts nothing", async () => {
    const fake = fakeTreza({ make_video: [[200, { ...QUOTE, sufficient: false, balanceUsd: 0.05 }]] });
    const out = (await trezaTools({ client: fake.client }).treza_generate_video.execute!({ prompt: "x" }, ctx)) as { error: string };
    expect(out.error).toContain("your Treza balance is $0.05");
    expect(fake.asked("run_pipeline")).toEqual([]);
  });

  it("image passes references and reports a free render", async () => {
    const fake = fakeTreza({
      make_image: [[200, { ...QUOTE, estimatedChargeUsd: 0, model: "google/gemini-2.5-flash-image" }]],
      run_pipeline: [[200, { runId: "r1" }]],
      get_run: [[200, { status: "success", outputs: { image: "https://media.trezalabs.com/i.png" } }]],
    });
    const out = await trezaTools({ client: fake.client }).treza_generate_image.execute!(
      { prompt: "a red kite", aspectRatio: "4:5", referenceImageUrls: ["https://media.trezalabs.com/ref.png"] },
      ctx,
    );
    expect(out).toMatchObject({ url: "https://media.trezalabs.com/i.png", price_usd: 0, model: "google/gemini-2.5-flash-image" });
    expect(fake.asked("make_image")).toEqual([{ prompt: "a red kite", aspectRatio: "4:5", referenceImageUrls: ["https://media.trezalabs.com/ref.png"] }]);
  });

  it("a slow render comes back running and get_run finishes it", async () => {
    const fake = fakeTreza({ make_video: [[200, QUOTE]], run_pipeline: [[200, { runId: "r1" }]], get_run: [[200, { status: "running" }], [200, DONE]] });
    const tools = trezaTools({ client: fake.client, waitSeconds: 0 });
    const out = (await tools.treza_generate_video.execute!({ prompt: "a fox runs" }, ctx)) as Record<string, string>;
    expect(out.status).toBe("running");
    expect(out.url).toBeUndefined();
    const later = await tools.treza_get_run.execute!({ pipelineId: out.pipeline_id!, runId: out.run_id! }, ctx);
    expect(later).toMatchObject({ url: "https://media.trezalabs.com/v.mp4", finished: true });
  });

  it("an abort while waiting cancels the render in Treza", async () => {
    const fake = fakeTreza({ make_video: [[200, QUOTE]], run_pipeline: [[200, { runId: "r1" }]], get_run: [[200, { status: "running" }]], cancel_run: [[200, {}]] });
    const client = new TrezaClient({
      apiKey: "k",
      fetch: (fake.client as unknown as { fetchFn: typeof fetch }).fetchFn,
      sleep: async () => {
        throw new Error("aborted");
      },
    });
    await expect(trezaTools({ client }).treza_generate_video.execute!({ prompt: "x" }, ctx)).rejects.toThrow("aborted");
    expect(fake.asked("cancel_run")).toEqual([{ pipelineId: "pipeline_1", runId: "r1" }]);
  });

  it("pipeline passes inputs", async () => {
    const fake = fakeTreza({
      estimate_run_cost: [[200, { pipelineId: "pipeline_9", quoteId: "q9", estimatedChargeUsd: 1.5, sufficient: true }]],
      run_pipeline: [[200, { runId: "r9" }]],
      get_run: [[200, { status: "success", outputs: { final: "https://media.trezalabs.com/f.mp4", note: "ok" } }]],
    });
    const out = await trezaTools({ client: fake.client, maxCostUsd: 2 }).treza_run_pipeline.execute!(
      { pipelineId: " pipeline_9 ", inputs: { prompt_1: "a lighthouse" } },
      ctx,
    );
    expect(out).toMatchObject({ url: "https://media.trezalabs.com/f.mp4", price_usd: 1.5, outputs: { note: "ok" } });
    expect(fake.asked("run_pipeline")).toEqual([{ pipelineId: "pipeline_9", inputs: { prompt_1: "a lighthouse" }, quoteId: "q9" }]);
  });

  it("a broken render says why", async () => {
    const fake = fakeTreza({ make_video: [[200, QUOTE]], run_pipeline: [[200, { runId: "r1" }]], get_run: [[200, { status: "error", statusNote: "The model refused the prompt." }]] });
    const out = (await trezaTools({ client: fake.client }).treza_generate_video.execute!({ prompt: "x" }, ctx)) as { error: string };
    expect(out.error).toContain("The model refused the prompt.");
  });

  it("balance, and a bad key says what to do", async () => {
    const fake = fakeTreza({ get_credit_balance: [[200, { balanceUsd: 20.76 }], [401, { error: "Invalid API key." }]] });
    const tools = trezaTools({ client: fake.client });
    expect(await tools.treza_balance.execute!({}, ctx)).toMatchObject({ balance_usd: 20.76 });
    expect(((await tools.treza_balance.execute!({}, ctx)) as { error: string }).error).toContain("Check your Treza API key");
  });

  it("the model cannot set the cap, the key or the wait", () => {
    const tools = trezaTools({ apiKey: "k", maxCostUsd: 1 });
    expect(Object.keys(tools).sort()).toEqual(["treza_balance", "treza_generate_image", "treza_generate_video", "treza_get_run", "treza_run_pipeline"]);
    for (const t of Object.values(tools)) {
      const shape = Object.keys((t.inputSchema as unknown as { shape: Record<string, unknown> }).shape);
      expect(shape.filter((k) => /cost|price|key|wait/i.test(k))).toEqual([]);
    }
    expect(Object.keys(trezaTools({ apiKey: "k", includePipelines: false }))).not.toContain("treza_run_pipeline");
  });

  it("needs a key", () => {
    const saved = process.env.TREZA_API_KEY;
    delete process.env.TREZA_API_KEY;
    expect(() => trezaTools()).toThrow(/TREZA_API_KEY/);
    process.env.TREZA_API_KEY = "treza_live_env";
    expect(() => trezaTools()).not.toThrow();
    if (saved === undefined) delete process.env.TREZA_API_KEY;
    else process.env.TREZA_API_KEY = saved;
  });

  it("runs inside generateText when a model calls it", async () => {
    const fake = fakeTreza({
      make_image: [[200, { ...QUOTE, estimatedChargeUsd: 0, model: "google/gemini-2.5-flash-image" }]],
      run_pipeline: [[200, { runId: "r1" }]],
      get_run: [[200, { status: "success", outputs: { image: "https://media.trezalabs.com/i.png" } }]],
    });
    let turn = 0;
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    const model = new MockLanguageModelV3({
      doGenerate: async () =>
        turn++ === 0
          ? {
              content: [{ type: "tool-call", toolCallId: "c1", toolName: "treza_generate_image", input: JSON.stringify({ prompt: "a red kite" }) }],
              finishReason: { unified: "tool-calls", raw: undefined },
              usage,
              warnings: [],
            }
          : { content: [{ type: "text", text: "Here is your picture." }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] },
    } as never);
    const result = await generateText({ model, tools: trezaTools({ client: fake.client }), stopWhen: stepCountIs(3), prompt: "Make a red kite." });
    const toolResult = result.steps.flatMap((s) => s.toolResults)[0]!;
    expect(toolResult.output).toMatchObject({ url: "https://media.trezalabs.com/i.png", price_usd: 0 });
    expect(result.text).toBe("Here is your picture.");
  });
});
