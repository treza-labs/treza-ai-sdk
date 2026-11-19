/**
 * A small client for Treza's REST API (POST /api/v1/tools/<name>).
 *
 * Every render follows the same order: ask Treza for a quote, stop if the quote
 * is over the max cost the developer set, start the render once at the quoted
 * price, then wait for the finished file.
 */

export const VERSION = "0.1.0";
export const USER_AGENT = `treza-ai-sdk/${VERSION}`;
export const TOP_UP_URL = "https://www.trezalabs.com/platform/settings";
export const KEYS_PAGE = "https://www.trezalabs.com/platform/api-keys";
const FINISHED = new Set(["success", "error", "partial", "cancelled"]);
const STALE_QUOTE_CODES = new Set(["STALE_QUOTE", "QUOTE_MISMATCH", "UNKNOWN_QUOTE"]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Data = Record<string, any>;
export type Answer = { ok: boolean; status: number; body: Data };

/** A refusal from Treza, worded so a person or a model can act on it. */
export class TrezaError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body: Data;
  constructor(message: string, status = 0, code?: string, body: Data = {}) {
    super(message);
    this.name = "TrezaError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** Drop empty values, so an optional field left out gets Treza's default. */
export function compact(fields: Data): Data {
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)),
  );
}

export function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** The optional price cap on a render: Infinity when there is none. */
export function maxCost(value: unknown): number {
  const n = toNumber(value);
  return n !== undefined && n > 0 ? n : Infinity;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

export type TrezaClientOptions = {
  apiKey: string;
  /** Treza's API. Tests point it at a mock. Defaults to TREZA_BASE_URL or https://www.trezalabs.com. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Replaced in tests so polling does not wait. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Aborted"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class TrezaClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: TrezaClientOptions) {
    this.apiKey = (options.apiKey ?? "").trim();
    const env = typeof process !== "undefined" ? process.env?.TREZA_BASE_URL : undefined;
    this.baseUrl = (options.baseUrl || env || "https://www.trezalabs.com").replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Call one tool without throwing on a refusal. */
  async request(tool: string, args: Data = {}, signal?: AbortSignal): Promise<Answer> {
    const response = await this.fetchFn(`${this.baseUrl}/api/v1/tools/${tool}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify(compact(args)),
      signal,
    });
    const text = await response.text();
    let body: Data;
    try {
      const parsed = JSON.parse(text);
      body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { result: parsed };
    } catch {
      body = { error: text.slice(0, 300) };
    }
    return { ok: response.status < 400, status: response.status, body };
  }

  async call(tool: string, args: Data = {}, signal?: AbortSignal): Promise<Data> {
    const { ok, status, body } = await this.request(tool, args, signal);
    if (ok) return body;
    throw refusal(status, body);
  }

  /** Quote, check the cap and the balance, then start the render once. */
  async startQuoted(maxCostUsd: number, quote: () => Promise<Answer>, inputs?: Data, signal?: AbortSignal): Promise<Data> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const quotedAnswer = await quote();
      const quoted = quotedAnswer.body;
      if (!quotedAnswer.ok) {
        if (quoted.code === "OVER_BUDGET") throw overBudget(toNumber(quoted.estimatedChargeUsd), maxCostUsd);
        throw refusal(quotedAnswer.status, quoted);
      }
      const pipelineId = String(quoted.pipelineId);
      const price = toNumber(quoted.estimatedChargeUsd);
      if (price === undefined || price > maxCostUsd) throw overBudget(price, maxCostUsd);
      if (quoted.sufficient === false) {
        throw new TrezaError(
          `This render costs ${usd(price)} and your Treza balance is ${usd(toNumber(quoted.balanceUsd) ?? 0)}. ` +
            `Nothing was spent. Add credits at ${quoted.topUpUrl || TOP_UP_URL}`,
          402,
          "InsufficientCredits",
        );
      }
      const base = compact({ pipelineId, inputs });
      const start = typeof quoted.quoteId === "string" ? { ...base, quoteId: quoted.quoteId } : { ...base, requestId: crypto.randomUUID() };
      const run = await this.request("run_pipeline", start, signal);
      if (run.ok) return { quoted, runId: String(run.body.runId), pipelineId, priceUsd: price };
      const code = run.body.code;
      if (attempt < 2 && STALE_QUOTE_CODES.has(code)) continue;
      if (code === "PRICE_CHANGED") {
        const newPrice = toNumber(run.body.estimatedChargeUsd);
        if (newPrice === undefined || newPrice > maxCostUsd) throw overBudget(newPrice, maxCostUsd);
        const again = await this.call("run_pipeline", { ...base, requestId: crypto.randomUUID() }, signal);
        return { quoted, runId: String(again.runId), pipelineId, priceUsd: newPrice };
      }
      throw refusal(run.status, run.body);
    }
    throw new TrezaError("Treza's quote kept changing. Try again.");
  }

  /**
   * Poll a run until it finishes or the wait is used up, and return it as last seen.
   * When the signal aborts mid-wait, the render is cancelled in Treza before the error goes on.
   */
  async waitForRun(pipelineId: string, runId: string, waitSeconds: number, signal?: AbortSignal): Promise<Data> {
    const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;
    for (;;) {
      const run = await this.call("get_run", { pipelineId, runId });
      if (run.status !== "running") return run;
      const pause = Math.min(Math.max(toNumber(run.pollAfterSec) ?? 3, 2), 10) * 1000;
      if (Date.now() + pause >= deadline) return run;
      try {
        await this.sleep(pause, signal);
      } catch (err) {
        await this.request("cancel_run", { pipelineId, runId }).catch(() => undefined);
        throw err;
      }
    }
  }
}

export function refusal(status: number, body: Data): TrezaError {
  const message = typeof body.error === "string" && body.error ? body.error : `Treza answered HTTP ${status}.`;
  const code = typeof body.code === "string" ? body.code : undefined;
  if (status === 401) return new TrezaError(`${message} Check your Treza API key (${KEYS_PAGE}).`, status, code, body);
  if (status === 402) return new TrezaError(`${message} Add credits at ${body.topUpUrl || TOP_UP_URL}`, status, code ?? "InsufficientCredits", body);
  if (status === 429) return new TrezaError(`${message} Wait ${Math.trunc(toNumber(body.retryAfterSec) ?? 60)} seconds and try again.`, status, code, body);
  return new TrezaError(message, status, code, body);
}

export function overBudget(price: number | undefined, maxCostUsd: number): TrezaError {
  return new TrezaError(
    `This render costs ${price !== undefined ? usd(price) : "more"}, over the Max cost of ${usd(maxCostUsd)}. Nothing was spent. ` +
      "Raise Max cost, or ask for less (a shorter clip or a cheaper model).",
    400,
    "OverBudget",
  );
}

/** The finished file: the named output, or else the first URL among the outputs. */
export function primaryUrl(run: Data, key?: string): string | undefined {
  const outputs: Data = run.outputs && typeof run.outputs === "object" ? run.outputs : {};
  if (key && typeof outputs[key] === "string") return outputs[key];
  return Object.values(outputs).find((v): v is string => typeof v === "string" && /^https?:\/\//.test(v));
}

/** Why a finished run stopped short, from its notes and the first step that broke. */
export function stoppedMessage(run: Data): string {
  if (run.status === "cancelled") {
    return `The render was cancelled${typeof run.cancelReason === "string" && run.cancelReason ? `: ${run.cancelReason}` : ""}.`;
  }
  const reasons: unknown[] = [run.statusNote, run.refusalNote];
  const broken = (Array.isArray(run.nodes) ? run.nodes : []).find((n: Data) => n && typeof n.error === "string");
  if (broken) reasons.push(`${broken.label || broken.type}: ${broken.error}`);
  const said = reasons.filter((r): r is string => typeof r === "string" && r.length > 0).join(" ");
  return `The render stopped before it finished. ${said}`.trim();
}

export type RenderResult = {
  url?: string;
  status: string;
  finished: boolean;
  price_usd?: number;
  model?: string;
  render_seconds?: number;
  outputs?: Data;
  run_id?: string;
  pipeline_id?: string;
  started_at?: string;
  finished_at?: string;
  status_note?: string;
};

/** One render as a flat result: the file first, then status, price and the IDs to look it up. */
export function runItem(run: Data, outputKey?: string, extra: Data = {}): RenderResult {
  const status = String(run.status || "running");
  const durationMs = toNumber(run.durationMs);
  return compact({
    url: primaryUrl(run, outputKey),
    status,
    finished: FINISHED.has(status),
    ...extra,
    render_seconds: durationMs !== undefined ? Math.round(durationMs / 100) / 10 : undefined,
    outputs: run.outputs && typeof run.outputs === "object" && Object.keys(run.outputs).length ? run.outputs : undefined,
    run_id: run.runId,
    pipeline_id: run.pipelineId,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    status_note: run.statusNote || run.refusalNote,
  }) as RenderResult;
}

/** A render that broke or was cancelled throws, with the reason. */
export function finishedOrThrow(run: Data): void {
  if (run.status === "error" || run.status === "cancelled") {
    throw new TrezaError(
      `${stoppedMessage(run)} Open the pipeline in Treza to see which step stopped: https://www.trezalabs.com/platform/pipelines/${run.pipelineId}`,
      0,
      run.status === "cancelled" ? "RenderCancelled" : "RenderStopped",
    );
  }
}
