/**
 * Treza tools for the Vercel AI SDK.
 *
 * `trezaTools()` returns tools for `generateText`, `streamText` and agents.
 * Each render tool asks Treza for a price, stops when the price is over
 * `maxCostUsd`, starts the render once and waits for the finished file.
 * `maxCostUsd`, the API key and the wait are set in your code, not by the
 * model, so an agent cannot raise a spending cap you set.
 */

import { tool } from "ai";
import { z } from "zod";

import {
  KEYS_PAGE,
  TOP_UP_URL,
  TrezaClient,
  TrezaError,
  compact,
  finishedOrThrow,
  maxCost,
  runItem,
  toNumber,
  type Data,
  type RenderResult,
} from "./client.js";

export { TrezaClient, TrezaError } from "./client.js";
export type { RenderResult } from "./client.js";

export type TrezaToolsOptions = {
  /** A Treza API key with the pipelines read, write and run permissions. Defaults to TREZA_API_KEY. */
  apiKey?: string;
  /** The most one render may cost, in US dollars. Treza prices it first and nothing is spent when it is higher. Leave out for no cap. */
  maxCostUsd?: number;
  /** How long to wait for a render, in seconds (default 300). One still going comes back with status "running". Keep it under your function's time limit. */
  waitSeconds?: number;
  /** Leave out `treza_run_pipeline` when the model should only generate. Default true. */
  includePipelines?: boolean;
  /** Throw TrezaError on a refusal (over the cap, low balance, a bad key) instead of returning `{ error }` to the model. Default false. */
  throwOnRefusal?: boolean;
  /** A ready client, for tests. */
  client?: TrezaClient;
};

/** What a tool hands back when Treza refuses: the reason, as text the model can act on. */
export type Refused = { error: string; code?: string };

export type Balance = { balance_usd?: number; approx_videos_remaining?: number; top_up_url: string };

function buildTools(options: TrezaToolsOptions) {
  const env = typeof process !== "undefined" ? process.env?.TREZA_API_KEY : undefined;
  const apiKey = (options.apiKey ?? env ?? "").trim();
  if (!apiKey && !options.client) {
    throw new Error(`Pass apiKey or set TREZA_API_KEY. Make a key at ${KEYS_PAGE}`);
  }
  const treza = options.client ?? new TrezaClient({ apiKey });
  const cap = maxCost(options.maxCostUsd);
  const limit = cap === Infinity ? undefined : cap;
  const waitSeconds = options.waitSeconds ?? 300;

  async function guard<T>(fn: () => Promise<T>): Promise<T | Refused> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof TrezaError && !options.throwOnRefusal) return compact({ error: err.message, code: err.code }) as Refused;
      throw err;
    }
  }

  async function render(started: Data, outputKey: string | undefined, signal?: AbortSignal): Promise<RenderResult> {
    const seen = await treza.waitForRun(started.pipelineId, started.runId, waitSeconds, signal);
    const run = { runId: started.runId, pipelineId: started.pipelineId, ...seen };
    finishedOrThrow(run);
    const model = started.quoted?.model;
    return runItem(run, outputKey, { price_usd: started.priceUsd, model: model && typeof model === "object" ? model.id : model });
  }

  const generateImage = tool({
    description:
      "Make a picture from a text description with Treza. Returns the finished picture's url, the price in US dollars and the model. Uses the account's prepaid Treza credits.",
    inputSchema: z.object({
      prompt: z.string().describe("What the picture shows."),
      aspectRatio: z.enum(["1:1", "16:9", "9:16", "4:5", "3:4", "4:3", "2:3", "3:2"]).optional().describe('The picture\'s shape. Defaults to "1:1".'),
      referenceImageUrls: z.array(z.string()).optional().describe("Links to pictures already in the Treza library to restyle or keep a character from."),
      model: z.string().optional().describe("A Treza model ID. Leave out for Treza's default."),
    }),
    execute: (input, { abortSignal }): Promise<RenderResult | Refused> =>
      guard(async () => {
        const args = compact({ ...input, maxPriceUsd: limit });
        return render(await treza.startQuoted(cap, () => treza.request("make_image", args, abortSignal), undefined, abortSignal), "image", abortSignal);
      }),
  });

  const generateVideo = tool({
    description:
      'Make a short video clip from a text description with Treza. Takes one to five minutes. Returns the finished clip\'s url, the price in US dollars and the model, or status "running" with a run_id and pipeline_id to pass to treza_get_run when it is not done in time. Uses the account\'s prepaid Treza credits.',
    inputSchema: z.object({
      prompt: z.string().describe("What happens in the clip."),
      aspectRatio: z.enum(["16:9", "9:16", "1:1"]).optional().describe('"16:9" wide (the default), "9:16" vertical (Shorts, Reels, TikTok) or "1:1" square.'),
      durationSec: z.number().min(1).max(60).optional().describe("Clip length in seconds, usually 4 to 10. Defaults to 4."),
      withAudio: z.boolean().optional().describe("Generate sound with the video where the model can. Defaults to true."),
      firstFrameUrl: z.string().optional().describe("Link to a picture in the Treza library that the clip opens on."),
      lastFrameUrl: z.string().optional().describe("Link to a picture in the Treza library that the clip ends on."),
      model: z.string().optional().describe("A Treza model ID. Leave out for Treza's default."),
    }),
    execute: (input, { abortSignal }): Promise<RenderResult | Refused> =>
      guard(async () => {
        const args = compact({ ...input, maxPriceUsd: limit });
        return render(await treza.startQuoted(cap, () => treza.request("make_video", args, abortSignal), undefined, abortSignal), "video", abortSignal);
      }),
  });

  const runPipeline = tool({
    description:
      'Run one of the account\'s saved Treza pipelines, with new inputs if given. Returns the url of what it made, all its outputs and the price, or status "running" with IDs for treza_get_run. Uses the account\'s prepaid Treza credits.',
    inputSchema: z.object({
      pipelineId: z.string().describe("The pipeline's ID. It is in the pipeline's address in Treza and starts with pipeline_."),
      inputs: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('One entry per input step of the pipeline, for example {"prompt_1": "a lighthouse at dawn"}. Leave out to run it as saved.'),
    }),
    execute: ({ pipelineId, inputs }, { abortSignal }): Promise<RenderResult | Refused> =>
      guard(async () => {
        const id = pipelineId.trim();
        if (!id) throw new TrezaError("Give the pipelineId. It is in the pipeline's address in Treza and starts with pipeline_.");
        const hasInputs = inputs && Object.keys(inputs).length > 0;
        const started = await treza.startQuoted(cap, () => treza.request("estimate_run_cost", { pipelineId: id }, abortSignal), hasInputs ? inputs : undefined, abortSignal);
        return render(started, undefined, abortSignal);
      }),
  });

  const getRun = tool({
    description: "Check a Treza render by its pipeline_id and run_id. Returns its status and, once finished, the url of the file. Free.",
    inputSchema: z.object({
      pipelineId: z.string().describe("The pipeline_id a Treza tool returned."),
      runId: z.string().describe("The run_id a Treza tool returned."),
    }),
    execute: ({ pipelineId, runId }, { abortSignal }): Promise<RenderResult | Refused> =>
      guard(async () => {
        const run = { runId, pipelineId, ...(await treza.call("get_run", { pipelineId, runId }, abortSignal)) };
        finishedOrThrow(run);
        return runItem(run);
      }),
  });

  const balance = tool({
    description: "Get the prepaid credit balance of the Treza account, in US dollars. Free.",
    inputSchema: z.object({}),
    execute: (_input, { abortSignal }): Promise<Balance | Refused> =>
      guard(async () => {
        const answer = await treza.call("get_credit_balance", {}, abortSignal);
        return compact({
          balance_usd: toNumber(answer.balanceUsd),
          approx_videos_remaining: answer.approxVideosRemaining,
          top_up_url: answer.topUpUrl || TOP_UP_URL,
        }) as Balance;
      }),
  });

  return {
    treza_generate_image: generateImage,
    treza_generate_video: generateVideo,
    treza_run_pipeline: runPipeline,
    treza_get_run: getRun,
    treza_balance: balance,
  };
}

/** Every Treza tool, keyed by the name the model sees. */
export type TrezaTools = ReturnType<typeof buildTools>;

/**
 * Treza's tools for `generateText`, `streamText` and agents: pictures, video
 * clips, saved pipelines, run lookup and balance.
 */
export function trezaTools(options: TrezaToolsOptions & { includePipelines: false }): Omit<TrezaTools, "treza_run_pipeline">;
export function trezaTools(options?: TrezaToolsOptions): TrezaTools;
export function trezaTools(options: TrezaToolsOptions = {}): TrezaTools | Omit<TrezaTools, "treza_run_pipeline"> {
  const all = buildTools(options);
  if (options.includePipelines !== false) return all;
  const { treza_run_pipeline: _left_out, ...rest } = all;
  return rest;
}
