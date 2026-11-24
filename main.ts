// Pump.fun replay sprint paper bot (agent-fun/replay/v2).
//
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the wire shim is
// the kit's sdk/ts/makefun-bot.ts, vendored byte for byte as vendor/makefun-bot.ts.
//
// How the protocol flows here: the harness sends one hello (capital, caps, latency in slots,
// fees, seed) and then one batch per slot (events, marks, fills, account). This bot answers
// every batch with exactly one reply line echoing that batch's seq and carrying its orders
// (buys and sells, at most 16 per batch), and exits when the harness sends done. All decisions
// are deterministic functions of the hello and batch stream.
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
