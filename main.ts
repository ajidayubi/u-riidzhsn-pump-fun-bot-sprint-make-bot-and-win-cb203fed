// Early-breakout flip bot for pump.fun bonding curves (agent-fun/replay/v2).
//
// Idea, in plain words: chasing the first spike loses — after a coin is up 15%
// it falls back 10% four times out of five, and sniping the first trades loses
// to the two-slot fill delay. What survives is the slow grinder: a coin that
// climbed 30-100% from creation over 20-100 trades, still buying (at least 16
// of its last 20 trades buys), still near its peak, on a buy trade right now.
// It risks a small fixed slice per coin, never more than five coins at once,
// and exits on a plain plan: a 50% gain is banked, a 10% loss is cut, and no
// coin is held longer than 3000 slots. Everything is decided from the replay
// state alone: no clock, no randomness, no network, so two runs agree byte for
// byte.
//
// hello: the harness sends one hello line, then one batch per slot, then done.
// batch: each batch carries this slot's events, marks and fills.
// orders: buys spend SOL (quote_lamports), sells hand back tokens; every order
// pays the base + priority tx fee whether it fills or not, so tiny orders lose
// money to fees and are skipped.
// slot: decisions are made on the batch for slot s and fill at slot s + 2.

import { runBot, LAMPORTS_PER_SOL, type BotState, type Batch, type OrderInput } from './vendor/makefun-bot.ts';

// ---- tuning knobs (all in whole units; price ratios use integer math) ----
const BUY_SIZE_LAMPORTS = 100_000_000n; // 0.10 SOL per coin at most
const MIN_BUY_SIZE_LAMPORTS = 15_000_000n; // below this the tx + curve fees eat the trade
const MIN_TRADES_AT_ENTRY = 20; // coin must have a track record first
const MAX_TRADES_AT_ENTRY = 100; // ...but still be in its early life
const MAX_AGE_SLOTS_AT_ENTRY = 150_000; // effectively no age cap; trades gate instead
const ENTRY_RISE_MIN_NUM = 130; // price between +30% ...
const ENTRY_RISE_MIN_DEN = 100;
const ENTRY_RISE_MAX_NUM = 200; // ... and +100% from its creation price
const ENTRY_RISE_MAX_DEN = 100;
const NEAR_PEAK_NUM = 97; // ...and within 3% of its peak so far
const NEAR_PEAK_DEN = 100;
const RECENT_WINDOW = 20; // last N trades watched for buy flow
const RECENT_BUYS_NEEDED = 16; // ...of which this many must be buys
const TAKE_PROFIT_NUM = 150; // bank the win at +50% over entry cost
const TAKE_PROFIT_DEN = 100;
const STOP_LOSS_NUM = 90; // cut the loss at -10% under entry cost
const STOP_LOSS_DEN = 100;
// No trailing exit: on these curves a dip from the peak is usually noise, and
// cutting there banks small wins while losers run to the stop.
const MAX_HOLD_SLOTS = 3000; // never hold a coin longer than this
const SLIPPAGE_BPS = 500; // 5% max slippage on every order
const MAX_POSITIONS = 5;

interface Price {
  q: bigint; // virtual SOL (quote) reserves
  t: bigint; // virtual token reserves
}

interface CoinTrack {
  createdSlot: number;
  base: Price; // price when the coin was first seen
  peak: Price; // highest price seen so far
  trades: number;
  lastIsBuy: boolean; // the latest trade was a buy: still rising now
  recentBuys: boolean[]; // last RECENT_WINDOW trades, buy or not
  recentBuyCount: number;
  decided: boolean; // a buy was already sent for this coin
}

interface HeldTrack {
  entrySlot: number;
}

function priceOf(state: BotState, mint: string): Price | null {
  const c = state.curves.get(mint);
  if (c === undefined) return null;
  if (c.virtual_token_reserves <= 0n || c.virtual_quote_reserves <= 0n) return null;
  return { q: c.virtual_quote_reserves, t: c.virtual_token_reserves };
}

/** True when price a is at least (num/den) times price b. Cross-multiplied, no floats. */
function priceAtLeast(a: Price, b: Price, num: number, den: number): boolean {
  return a.q * b.t * BigInt(den) >= a.t * b.q * BigInt(num);
}

/** True when price a is at most (num/den) times price b. */
function priceAtMost(a: Price, b: Price, num: number, den: number): boolean {
  return a.q * b.t * BigInt(den) <= a.t * b.q * BigInt(num);
}

/** True when price a is strictly above price b. */
function priceAbove(a: Price, b: Price): boolean {
  return a.q * b.t > b.q * a.t;
}

const coins = new Map<string, CoinTrack>();
const held = new Map<string, HeldTrack>();

function trackFor(state: BotState, mint: string): CoinTrack | null {
  let track = coins.get(mint);
  if (track !== undefined) return track;
  const price = priceOf(state, mint);
  if (price === null) return null;
  const curve = state.curves.get(mint);
  track = {
    createdSlot: curve !== undefined && curve.created_slot !== null ? curve.created_slot : state.slot,
    base: price,
    peak: price,
    trades: 0,
    lastIsBuy: false,
    recentBuys: [],
    recentBuyCount: 0,
    decided: false,
  };
  coins.set(mint, track);
  return track;
}

await runBot({
  onHello(state) {
    console.error(`hello: capital ${state.cash} lamports, max ${MAX_POSITIONS} positions`);
  },

  onBatch(state: BotState, batch: Batch) {
    const orders: OrderInput[] = [];

    // Fills that came back rejected or failed free the coin for another try
    // while it is still young; filled buys show up as positions below.
    for (const fill of batch.fills) {
      if (fill.status !== 'filled' && fill.side === 'buy') {
        const track = coins.get(fill.mint);
        if (track !== undefined) track.decided = false;
      }
    }

    // Fold this batch's events into the per-coin tracks, and collect the
    // mints that traded this slot as this batch's only buy candidates.
    const candidates: string[] = [];
    for (const event of batch.events) {
      if (event.event === 'CompleteEvent') {
        coins.delete(event.mint);
        held.delete(event.mint);
        continue;
      }
      const track = trackFor(state, event.mint);
      if (track === null) continue;
      if (event.event === 'CreateEvent') {
        track.createdSlot = event.slot;
        const price = priceOf(state, event.mint);
        if (price !== null) track.base = price;
        continue;
      }
      // TradeEvent.
      track.trades += 1;
      track.lastIsBuy = event.is_buy;
      const tradePrice = priceOf(state, event.mint);
      if (tradePrice !== null && priceAbove(tradePrice, track.peak)) track.peak = tradePrice;
      track.recentBuys.push(event.is_buy);
      if (event.is_buy) track.recentBuyCount += 1;
      if (track.recentBuys.length > RECENT_WINDOW) {
        if (track.recentBuys.shift() === true) track.recentBuyCount -= 1;
      }
      // A coin that grew old without ever qualifying is forgotten, so the
      // track map only holds young coins. A held coin is never forgotten here;
      // its exit is handled by the position loop below.
      if (!state.positions.has(event.mint) && !track.decided) {
        if (track.trades > MAX_TRADES_AT_ENTRY || state.slot - track.createdSlot > MAX_AGE_SLOTS_AT_ENTRY) {
          coins.delete(event.mint);
          continue;
        }
      }
      candidates.push(event.mint);
    }

    // ---- exits first: free a slot before deciding on new buys. ----
    const pendingSell = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSell.add(p.order.mint);
    }
    for (const [mint, holding] of state.positions) {
      if (pendingSell.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = priceOf(state, mint);
      if (price === null) continue;
      let track = held.get(mint);
      if (track === undefined) {
        track = { entrySlot: state.slot };
        held.set(mint, track);
      }
      // Entry cost as a price: cost lamports per token held.
      const entry: Price = { q: holding.cost_lamports, t: holding.token_amount };
      const takeProfit = priceAtLeast(price, entry, TAKE_PROFIT_NUM, TAKE_PROFIT_DEN);
      const stopLoss = priceAtMost(price, entry, STOP_LOSS_NUM, STOP_LOSS_DEN);
      const timedOut = state.slot - track.entrySlot >= MAX_HOLD_SLOTS;
      if (takeProfit || stopLoss || timedOut) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        held.delete(mint);
      }
    }
    // Positions that vanished (sold, completed, flattened) drop their tracks.
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }

    // ---- entries: only coins that traded this slot, only while young. ----
    if (state.committedPositionCount() < MAX_POSITIONS) {
      const seen = new Set<string>();
      for (const mint of candidates) {
        if (seen.has(mint)) continue;
        seen.add(mint);
        if (state.committedPositionCount() >= MAX_POSITIONS) break;
        if (state.positions.has(mint)) continue;
        const track = coins.get(mint);
        if (track === undefined || track.decided) continue;
        if (track.trades < MIN_TRADES_AT_ENTRY || track.trades > MAX_TRADES_AT_ENTRY) continue;
        if (state.slot - track.createdSlot > MAX_AGE_SLOTS_AT_ENTRY) continue;
        if (track.recentBuyCount < RECENT_BUYS_NEEDED) continue;
        // Still rising right now.
        if (!track.lastIsBuy) continue;
        const price = priceOf(state, mint);
        if (price === null) continue;
        // Climbed 30-100% from creation, and still within 3% of its peak.
        if (!priceAtLeast(price, track.base, ENTRY_RISE_MIN_NUM, ENTRY_RISE_MIN_DEN)) continue;
        if (!priceAtMost(price, track.base, ENTRY_RISE_MAX_NUM, ENTRY_RISE_MAX_DEN)) continue;
        if (!priceAtLeast(price, track.peak, NEAR_PEAK_NUM, NEAR_PEAK_DEN)) continue;
        // Size: fixed slice, capped at 1% of the real SOL reserve (the
        // harness cap) and at the free cash after fees.
        let size = BUY_SIZE_LAMPORTS;
        const cap = state.maxBuyLamports(mint);
        if (cap < size) size = cap;
        const free = state.freeCashLamports() - state.txFeeLamports();
        if (free < size) size = free;
        if (size < MIN_BUY_SIZE_LAMPORTS) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: size,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        track.decided = true;
      }
    }

    return orders;
  },

  onDone(state) {
    console.error(
      `done: batches answered, final cash ${state.cash} lamports, ` +
        `${state.positions.size} positions left, ${coins.size} coins tracked`,
    );
  },
});
