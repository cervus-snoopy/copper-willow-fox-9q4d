// Paper bot for the pump.fun replay sprint (agent-fun/replay/v2).
//
// Idea, from the dev window's own tape: almost every new coin bleeds to zero, but a small
// minority of genuinely active launches runs hard within its first few hundred slots. So the bot
// buys only launches whose opening tape shows real crowd interest (several distinct buyers, net
// SOL flowing in, creator not selling) and whose price has not already run more than 30% off its
// create price (one-slot bundle pumps are the classic loser), buys once per coin up to 0.03 SOL
// within the 1%-of-real-reserve size cap, cuts losers fast at -8%, banks half at +20%, and lets
// the rest ride under a ratchet trailing stop that never gives back below +10% once armed.
// Positions are small (0.03 SOL) and at most five are open, so a dead coin costs little and a
// runner pays for many.
//
// The bot is a pure function of the hello and batch messages it is fed: no clock, no randomness,
// no I/O, no environment reads. Iteration is over insertion-ordered maps fed by the batch stream,
// so the two graded executions produce byte-identical action logs.

import {
  BPS,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

export interface Params {
  /** Target SOL per coin in total (lamports). */
  stakeLamports: bigint;
  /** Smallest single buy worth paying the transaction fee for (lamports). */
  minBuyLamports: bigint;
  /** Youngest age (slots since CreateEvent) at which a first buy may be decided. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Oldest age at which top-up buys may still be decided. */
  topUpAge: number;
  /** Minimum real SOL reserve at decision time (lamports). */
  minRealSolLamports: bigint;
  /** Distinct non-creator buyers seen before entry, at least. */
  minBuyers: number;
  /** Net SOL bought minus sold since create, at least (lamports). */
  minNetSolLamports: bigint;
  /** Creator's own buys in the create slot, at most (lamports). */
  maxDevBuyLamports: bigint;
  /** Lamports sold by others / lamports bought, at most (bps). */
  maxSellRatioBps: number;
  /** Price now over the create price, at most (bps over 10000). */
  maxRunupBps: number;
  /** Price now over the create price, at least (bps over 10000). 0 = off. */
  minRunupBps: number;
  /** Trades seen before entry, at least. */
  minTrades: number;
  /** Exit when the position is worth this much under its cost (bps). */
  stopLossBps: number;
  /** Trailing stop arms once the position is worth this much over its cost (bps). */
  armBps: number;
  /** Once armed, exit on a fall of this much from the best value (bps). */
  trailBps: number;
  /** Once armed, never sell the remainder below this much over its cost (bps). */
  floorBps: number;
  /** First take-profit: sell tp1PartBps of the position here (bps over cost). */
  tp1Bps: number;
  /** Share of the position the first take-profit sells (bps). */
  tp1PartBps: number;
  /** Exit after holding this many slots regardless. */
  maxHold: number;
  /** The time limit does not apply while the position is up at least this much (bps). */
  holdIfUpBps: number;
  /** Exit when net SOL over the fade window falls below minus this (lamports). 0 = off. */
  fadeNetSolLamports: bigint;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
}

export const DEFAULT_PARAMS: Params = {
  stakeLamports: 30_000_000n,
  minBuyLamports: 5_000_000n,
  minAge: 2,
  maxAge: 30,
  topUpAge: 0,
  minRealSolLamports: 1_000_000_000n,
  minBuyers: 5,
  minNetSolLamports: 1_000_000_000n,
  maxDevBuyLamports: 2_500_000_000n,
  maxSellRatioBps: 3000,
  maxRunupBps: 3000,
  minRunupBps: 0,
  minTrades: 3,
  stopLossBps: 800,
  armBps: 1500,
  trailBps: 3500,
  floorBps: 2000,
  tp1Bps: 2000,
  tp1PartBps: 5000,
  maxHold: 300,
  holdIfUpBps: 1000,
  fadeNetSolLamports: 0n,
  staleSlots: 200,
  exitOnDevSell: true,
  buySlippageBps: 10_000,
};

/** Curve fee share (protocol 95 bps + creator 30 bps) taken off every sell. */
const CURVE_FEE_BPS = 125n;

interface Tick {
  slot: number;
  buy: boolean;
  sol: bigint;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-time virtual reserves: the price run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  devSold: boolean;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  lastTradeSlot: number;
  /** Recent trades, for the top-up flow check (older ones pruned as new ones come). */
  recent: Tick[];
  buysSent: number;
  /** Lamports of buys sent (decision amounts), including ones still in flight. */
  spentSent: bigint;
  /** Decision price (vq/vt pair) of the last buy sent. */
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  /** Transaction fees paid on this position's orders so far. */
  txPaid: bigint;
  /** Best net value (lamports) of the tokens still held; 0 until measured. */
  best: bigint;
  /** Trailing stop armed (value reached cost * (1 + armBps)). */
  armed: boolean;
  devSoldAtOpen: boolean;
  tookTp1: boolean;
}

interface SentOrder {
  mint: Pubkey;
  side: 'buy' | 'sell';
  amount: bigint;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(params: Params = DEFAULT_PARAMS) {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  /** Orders sent, by the client_id this bot assigned, until their fill arrives. */
  const sent = new Map<string, SentOrder>();
  let nextId = 1;

  const clientId = (): string => `b${nextId++}`;

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === 'buy') return true;
    }
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === 'sell') return true;
    }
    return false;
  }

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          devSold: false,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          lastTradeSlot: e.slot,
          recent: [],
          buysSent: 0,
          spentSent: 0n,
          lastBuyVq: 0n,
          lastBuyVt: 1n,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, buy: e.is_buy, sol });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Net lamports bought minus sold over the last `window` slots. */
  function flow(c: Coin, slot: number, window: number): bigint {
    const from = slot - window;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    for (const t of c.recent) net += t.buy ? t.sol : -t.sol;
    return net;
  }

  /** Entry filter on a coin's opening tape at slot `now`. */
  function entryOk(c: Coin, now: number, curve: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint; real_quote_reserves: bigint }): boolean {
    const age = now - c.createSlot;
    if (age < P.minAge || age > P.maxAge) return false;
    if (c.bought - c.soldByOthers < P.minNetSolLamports) return false;
    if (c.buyers.size < P.minBuyers) return false;
    if (c.trades < P.minTrades) return false;
    if (c.devSold) return false;
    if (c.devBuy > P.maxDevBuyLamports) return false;
    if (c.bought > 0n && (c.soldByOthers * BPS) / c.bought > BigInt(P.maxSellRatioBps)) return false;
    if (curve.real_quote_reserves < P.minRealSolLamports) return false;
    // Price now over the create price, within [minRunupBps, maxRunupBps].
    if (c.vq0 > 0n && c.vt0 > 0n) {
      const left = curve.virtual_quote_reserves * c.vt0 * BPS;
      const right = curve.virtual_token_reserves * c.vq0 * (BPS + BigInt(P.maxRunupBps));
      if (left > right) return false;
      if (P.minRunupBps > 0) {
        const minRight = curve.virtual_token_reserves * c.vq0 * (BPS + BigInt(P.minRunupBps));
        if (left < minRight) return false;
      }
    }
    return true;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      readEvents(batch);
      const tx = state.txFeeLamports();
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      // Fold fills in: track tx fees per position, un-count rejected/failed buys,
      // and drop positions the harness closed (client ids starting with `_`).
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const s = sent.get(f.client_id);
        if (s !== undefined) {
          if (s.side === 'buy' && f.status !== 'filled') {
            const c = coins.get(f.mint);
            if (c !== undefined) c.spentSent -= s.amount;
          }
          if (f.status !== 'rejected') {
            const h = held.get(f.mint);
            if (h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
          }
          sent.delete(f.client_id);
        }
        if (f.side === 'buy' && f.status === 'filled' && !held.has(f.mint)) {
          held.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            best: 0n,
            armed: false,
            devSoldAtOpen: coins.get(f.mint)?.devSold ?? false,
            tookTp1: false,
          });
        }
      }
      for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
      }

      const sendBuy = (mint: Pubkey, amount: bigint): void => {
        const id = clientId();
        sent.set(id, { mint, side: 'buy', amount });
        orders.push({ side: 'buy', client_id: id, mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        const c = coins.get(mint);
        if (c !== undefined) {
          c.buysSent += 1;
          c.spentSent += amount;
          const cv = state.curves.get(mint);
          if (cv !== undefined) {
            c.lastBuyVq = cv.virtual_quote_reserves;
            c.lastBuyVt = cv.virtual_token_reserves;
          }
        }
      };
      const sendSell = (mint: Pubkey, tokens: bigint, full: boolean): void => {
        const id = clientId();
        sent.set(id, { mint, side: 'sell', amount: tokens });
        orders.push({ side: 'sell', client_id: id, mint, token_amount: tokens, max_slippage_bps: 10_000 });
        if (full) {
          selling.add(mint);
          const c = coins.get(mint);
          if (c !== undefined) c.done = true;
        }
      };

      // Exits first: stop loss, armed ratchet trail, take-profit, time and stale exits.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = {
            openedSlot: state.slot,
            txPaid: tx,
            best: 0n,
            armed: false,
            devSoldAtOpen: c?.devSold ?? false,
            tookTp1: false,
          };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined || cv.complete) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (basis <= 0n) continue;
        if (value > h.best) h.best = value;
        if (!h.armed && value * BPS >= basis * (BPS + BigInt(P.armBps))) h.armed = true;
        let exit = false;
        if (value * BPS <= basis * (BPS - BigInt(P.stopLossBps))) exit = true;
        if (!exit && h.armed) {
          const floorFromPeak = (h.best * (BPS - BigInt(P.trailBps))) / BPS;
          const floorFromCost = (basis * (BPS + BigInt(P.floorBps))) / BPS;
          const floor = floorFromPeak > floorFromCost ? floorFromPeak : floorFromCost;
          if (value <= floor) exit = true;
        }
        if (!exit && state.slot - h.openedSlot >= P.maxHold && value * BPS < basis * (BPS + BigInt(P.holdIfUpBps))) exit = true;
        if (c !== undefined) {
          if (!exit && P.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
          if (!exit && state.slot - c.lastTradeSlot >= P.staleSlots) exit = true;
          if (!exit && P.fadeNetSolLamports > 0n && flow(c, state.slot, 30) < -P.fadeNetSolLamports) exit = true;
        }
        if (exit) {
          sendSell(mint, pos.token_amount, true);
          continue;
        }
        // First take-profit: bank half once the position is up tp1Bps.
        if (!h.tookTp1 && value * BPS >= basis * (BPS + BigInt(P.tp1Bps))) {
          const part = (pos.token_amount * BigInt(P.tp1PartBps)) / BPS;
          if (part > 0n && part < pos.token_amount && orders.length < cap) {
            sendSell(mint, part, false);
            h.tookTp1 = true;
            h.best = 0n;
          }
        }
      }

      // Entries and top-ups.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (hasPendingBuy(state, c.mint)) continue;
        const pos = state.positions.get(c.mint);
        const isHeld = pos !== undefined;
        if (!isHeld && open >= state.hello.caps.max_open_positions) continue;
        if (!isHeld) {
          if (c.buysSent > 0) continue;
          if (age > P.maxAge) {
            c.done = true;
            continue;
          }
          if (!entryOk(c, state.slot, curve)) continue;
        } else {
          // Top-up: only while young, only into strength (price near the last buy's,
          // recent flow not negative), and only up to the stake.
          if (c.spentSent >= P.stakeLamports) continue;
          if (age > P.topUpAge) continue;
          if (held.get(c.mint)?.tookTp1) continue;
          if (c.lastBuyVt > 0n && c.lastBuyVq > 0n) {
            const left = curve.virtual_quote_reserves * c.lastBuyVt * 95n;
            const right = curve.virtual_token_reserves * c.lastBuyVq * 100n;
            if (left < right) continue;
          }
          if (flow(c, state.slot, 30) < 0n) continue;
        }
        const capLamports = state.maxBuyLamports(c.mint);
        let amount = P.stakeLamports - c.spentSent;
        if (amount > capLamports) amount = capLamports;
        if (amount > free - tx) amount = free - tx;
        if (amount < P.minBuyLamports) continue;
        sendBuy(c.mint, amount);
        free -= amount + tx;
        if (!isHeld) open += 1;
      }
      return orders;
    },
  };
}
