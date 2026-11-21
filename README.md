# @treza/ai-sdk

[Treza](https://www.trezalabs.com) tools for the [Vercel AI SDK](https://ai-sdk.dev). A model can generate AI pictures and video clips and run your saved Treza pipelines. Treza prices every render first, and a `maxCostUsd` you set stops any render that costs more, with nothing spent.

## What Treza makes

![Four short clips made with Treza: a red hover car racing through a neon city, an astronaut walking over a Martian dune at sunset, an orchid mantis on a leaf, and espresso pouring into a cup](https://raw.githubusercontent.com/treza-labs/treza-labs/main/assets/treza-demo.gif)

These clips were made with [Treza](https://www.trezalabs.com), and the [AI SDK integration page](https://www.trezalabs.com/integrations/ai-sdk) shows how to set up these tools.

## Install

```bash
npm install @treza/ai-sdk ai zod
```

Works with AI SDK 5, 6 and 7.

Create a Treza account at https://www.trezalabs.com, add credits, and make an API key at https://www.trezalabs.com/platform/api-keys with the `pipelines:read`, `pipelines:write` and `pipelines:run` permissions. Then:

```bash
export TREZA_API_KEY="treza_live_..."
```

The package is free. Renders are paid from your prepaid Treza credits; there is no subscription.

## Use it

```ts
import { generateText, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { trezaTools } from "@treza/ai-sdk";

const { text } = await generateText({
  model: anthropic("claude-sonnet-5-5"),
  tools: trezaTools({ maxCostUsd: 1.0 }),
  stopWhen: stepCountIs(5),
  prompt: "Make a 4 second vertical clip of a fox in snow and give me the link.",
});
```

`trezaTools()` returns an object of tools, so it also works with `streamText` and agents. Spread it to mix in your own tools: `tools: { ...trezaTools({ maxCostUsd: 1 }), myTool }`.

## Tools

| Name the model sees | What it does | Cost |
| --- | --- | --- |
| `treza_generate_image` | A picture from a prompt, optionally from reference pictures. | Treza credits |
| `treza_generate_video` | A video clip from a prompt, optionally opening or ending on a picture. | Treza credits |
| `treza_run_pipeline` | Runs one of your saved Treza pipelines, with new inputs if given. | Treza credits |
| `treza_get_run` | Looks up a render that was still going when its tool stopped waiting. | Free |
| `treza_balance` | The credits left on the account. | Free |

A finished render comes back as an object:

```json
{"url": "https://media.trezalabs.com/...mp4", "status": "success", "finished": true,
 "price_usd": 0.28, "model": "google/veo-3.1-lite", "render_seconds": 56,
 "run_id": "...", "pipeline_id": "pipeline_..."}
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | `TREZA_API_KEY` | A Treza API key. |
| `maxCostUsd` | no cap | The most one render may cost. |
| `waitSeconds` | `300` | How long a tool waits for a render. |
| `includePipelines` | `true` | Set `false` to leave out `treza_run_pipeline`. |
| `throwOnRefusal` | `false` | Throw `TrezaError` on a refusal instead of returning `{ error }` to the model. |

## Spending

- `maxCostUsd` is set in your code. The model cannot see or change it, and it cannot see the API key.
- With a cap set, Treza prices the render first. If the price is higher, the tool returns `{ error: "This render costs $X, over the Max cost of $Y. Nothing was spent. ..." }` and starts nothing.
- With no cap, a render runs at Treza's quoted price as long as the balance covers it. **Set a cap on tools you give to an agent.**
- A render never starts when the balance does not cover its price.

## Long renders and serverless time limits

Pictures usually take under a minute and videos one to five minutes. A tool waits up to `waitSeconds`. A render still going after that comes back with `"status": "running"` and its `run_id` and `pipeline_id`, not as an error, and nothing is started twice. `treza_get_run` returns the file once it is done.

On a serverless function, set `waitSeconds` below the function's time limit (for example `waitSeconds: 50` under a 60 second limit), and let the model call `treza_get_run` on a later request.

If the request is aborted while a tool is waiting (the AI SDK passes its `abortSignal`), the render is cancelled in Treza too. A step that already finished is not refunded.

## Network and privacy

The tools call Treza's API over HTTPS at `www.trezalabs.com`. They send the prompt and settings with your API key, and store nothing. Run them on the server: the API key must not reach the browser. Privacy policy: https://docs.trezalabs.com/terms-and-privacy/privacy

## Development

```bash
npm install
npm test
```

The tests run against a scripted stand-in for Treza's API, including one pass through `generateText` with a mock model.

## Support

Issues: https://github.com/treza-labs/treza-ai-sdk/issues · Email: hello@trezalabs.com

MIT licensed.
