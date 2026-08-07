// ui/help.js — the mission brief: a paged rules sheet.
//
// §3.9 is the bar: no rule may exist that this screen does not state. Every
// claim below was read out of game.js before it was written, and the function
// that implements it is named in a comment beside it. When game.js and this
// file disagree, game.js wins and this file is the bug.
//
// Paged rather than one long scroll because the old client's single wall of
// text was skipped whole; each page is one question a player actually asks.

import { el, clear, setAttr, setClass } from '../core/dom.js';
import * as pointer from '../interact/pointer.js';
import { openSheet } from './screens.js';
import {
  COLORS, COLOR_KEYS, HAND_LIMIT, SETS_TO_WIN, ACTION_RULES, ACTION_COUNTS,
  RENT_COUNTS, colorName, opsecFlag, DECK_CYCLE_LIMIT, deckCycleNotice,
} from '../core/cards.js';

/* ── small builders ──────────────────────────────────────────────────────── */

const p = (text, cls = '') => el('p', { class: cls || null, text });

function bullets(lines) {
  const list = el('ul', { class: 'brief-list' });
  for (const line of lines) list.appendChild(el('li', { text: line }));
  return list;
}

/** A labelled rule row: the claim in bold, the consequence under it. */
function rules(rows) {
  const box = el('dl', { class: 'brief-rules' });
  for (const [term, def] of rows) {
    box.appendChild(el('dt', { text: term }));
    box.appendChild(el('dd', { text: def }));
  }
  return box;
}

function note(text) { return el('p', { class: 'brief-note', text }); }

function swatch(color) {
  return el('span', { class: 'brief-swatch', dataset: { color } });
}

/* ── page: goal & final approach ─────────────────────────────────────────── */

/**
 * The armed state, drawn. Three complete sets do not win (game.js syncSets sets
 * player.finalApproach instead of finishing); the win resolves at the armed
 * player's own turn start once a full cycle has passed
 * (resolveFinalApproach → checkpointReached: turnsSinceArming >= activeCount).
 */
function approachDiagram() {
  const step = (kind, tag, text) => el('li', { class: `fa-step is-${kind}` }, [
    el('span', { class: 'fa-tag', text: tag }),
    el('span', { class: 'fa-text', text }),
  ]);

  const board = el('div', { class: 'fa-board' }, [
    el('span', { class: 'fa-board-label', text: 'ARMED BOARD' }),
    el('div', { class: 'fa-cols' }, ['red', 'darkblue', 'base'].map((color) =>
      el('div', { class: 'fa-col is-complete', dataset: { color } }, [
        el('span', { class: 'fa-col-name', text: COLORS[color].short }),
        el('span', { class: 'fa-col-pips' },
          Array.from({ length: COLORS[color].size }, () => el('i'))),
        el('span', { class: 'fa-col-tick', text: 'SET' }),
      ]))),
    el('span', { class: 'fa-board-count', text: '3 / 3 COMPLETE' }),
  ]);

  return el('div', { class: 'fa-diagram' }, [
    board,
    el('ol', { class: 'fa-steps' }, [
      step('arm', 'ARMED', 'Your third set completes. You do NOT win yet.'),
      // checkpointReached(): turnCounter − armedAtTurn >= activeCount. Arming on
      // someone else's turn puts one of YOUR OWN turns inside that window, and
      // that turn does not convert — so the opponents get a second one each.
      step('wait', 'CYCLE', 'Every other player gets at least one full turn to break you — '
        + 'up to two each if you armed on someone else\'s turn.'),
      step('break', 'OR BREAK', 'Lose any set in that window and you are disarmed. '
        + 'Rebuild it and you re-arm — the count restarts at zero.'),
      // beginTurn() → resolveFinalApproach(): the FIRST own-turn start at or
      // after armedAtTurn + activeCount, which is not always the very next one.
      step('win', 'CHECKPOINT', 'The first of your own turns to start after that full '
        + `cycle. Still holding ${SETS_TO_WIN}? That is the win.`),
    ]),
  ]);
}

function pageGoal() {
  return [
    p(`Complete ${SETS_TO_WIN} property sets. Completing the third does not win the game — `
      + 'it arms your FINAL APPROACH.', 'brief-lede'),
    approachDiagram(),
    rules([
      // syncSets(): sets >= SETS_TO_WIN && !finalApproach → arm + emit final_approach.
      ['Arming is public',
        'The moment you hold three complete sets the whole table is told, and a banner '
        + 'names you until it resolves.'],
      // checkpointReached(): turnsSinceArming >= activeCount — a whole cycle, so
      // arming on the seat before yours still gives everyone a turn.
      ['The grace is a full cycle',
        'Not "one turn" — every other player is guaranteed a turn to answer, no matter '
        + 'when in the round you armed.'],
      // resolveFinalApproach() is called from beginTurn() and drawCards().
      ['The win lands on your turn start',
        'If you still hold three complete sets when your own next turn begins after that '
        + 'cycle, the game ends there.'],
      // The question every armed player asks. turnsSinceArming counts EVERY
      // seat's turn, so an own-turn inside the window is spent, not cashed.
      ['"Why didn\'t I win on my own turn?"',
        'Because the cycle was not finished yet. Arm on somebody else\'s turn and one of '
        + 'your own turns falls inside the grace window — that turn passes without '
        + 'converting, and you win on the NEXT one. The banner never counts your own '
        + 'turns as answers.'],
      // syncSets(): sets < SETS_TO_WIN && finalApproach → disarm, delete armedAtTurn.
      ['Breaking resets everything',
        'Drop below three and you are disarmed. Build back up and you re-arm, but the '
        + 'grace cycle starts over from zero.'],
      // armedPlayers() is a list; first player whose beginTurn passes the check wins.
      ['Several can be armed at once',
        'The first one to reach their own checkpoint still holding three wins.'],
    ]),
    el('h5', { class: 'brief-sub', text: 'How you break someone on final approach' }),
    bullets([
      // playAction 'chud' has no zoneRequisitionable guard, and nothing goes
      // back the other way — that, not "can reach a complete set", is what is
      // unique about it (§3.1 P7 ruling).
      'THE CHUD CARD — takes a property straight out of a complete set and gives nothing '
      + 'back. The only card that robs one.',
      // executeEntry 'steal_set'.
      'Inspector General — seizes the whole set, Upgrade and FOC included.',
      // playAction 'tdy_orders' has no complete-set guard either, and
      // executeEntry 'swap' splices out of whatever colour holds the card.
      'TDY Orders — trades INTO a complete set: their set card for one of yours. Both '
      + 'boards resync, so it can break a set on either side.',
      // processPayment: propCards come out of properties, then syncSets(payer).
      'Charge them more than their bank covers, so they must pay with a set card.',
      // playAction 'midnight_requisition' → zoneRequisitionable(): n > 0 && n < size.
      'Midnight Requisition cannot — it refuses any zone that is already a complete set.',
    ]),
  ];
}

/* ── page: your turn ─────────────────────────────────────────────────────── */

function pageTurn() {
  return [
    // beginTurn() draws automatically; drawCards(): count = hand.length === 0 ? 5 : 2.
    p('Your cards are dealt for you, then up to three plays, then get down to the hand limit.',
      'brief-lede'),
    rules([
      ['1 · The deal is automatic',
        'Two cards land in your hand the moment your turn starts — five if your hand was '
        + 'empty. There is nothing to press.'],
      // playsRemaining = 3; playAsMoney / playProperty / playAction each decrement it.
      ['2 · Up to 3 plays', 'A play is: bank a card for its value, place a property, play an '
        + 'action or rent card, or add an Upgrade / FOC to a complete set.'],
      // moveProperty() never touches playsRemaining.
      ['Free, unlimited', 'Moving a wild that is already on your board from one set to another '
        + 'costs no play, and you may do it as often as you like on your turn.'],
      // endTurn(): hand.length > HAND_LIMIT → needDiscard with the excess.
      [`3 · Hand limit ${HAND_LIMIT}`, `End your turn holding at most ${HAND_LIMIT} cards. `
        + 'Over the limit, you choose what goes to the discard.'],
    ]),
    note('Money cards are only ever banked — there is nothing else to do with them.'),
    bullets([
      // delete state._surgeOps in endTurn().
      'Surge Operations expires when your turn ends, spent or not.',
      // respondToAction runs whenever pendingAction lists you, regardless of turn.
      'You can be charged and you can play OPSEC on anyone\'s turn. Demands are answered '
      + 'the moment they land.',
      // drawCards() calls checkWin() before drawing.
      'A set you complete on someone else\'s turn — from a payment, a steal, a swap — arms '
      + 'your final approach right then.',
    ]),
  ];
}

/* ── page: sets & rent ───────────────────────────────────────────────────── */

/** COLORS in game.js is the source; core/cards.js mirrors it (see its header). */
function setsTable() {
  const head = el('tr', {}, [
    el('th', { text: 'Set' }),
    el('th', { class: 'num', text: 'Cards' }),
    el('th', { text: 'Rent per card held' }),
  ]);
  const rows = COLOR_KEYS.slice()
    .sort((a, b) => COLORS[a].size - COLORS[b].size
      || COLORS[a].rent[COLORS[a].rent.length - 1] - COLORS[b].rent[COLORS[b].rent.length - 1])
    .map((color) => {
      const info = COLORS[color];
      const ladder = el('td', { class: 'ladder' }, info.rent.map((amount, i) =>
        el('span', { class: `rung${i === info.rent.length - 1 ? ' is-full' : ''}` }, [
          el('i', { text: `${i + 1}` }),
          el('b', { text: `${amount}M` }),
        ])));
      return el('tr', {}, [
        el('td', { class: 'setname' }, [swatch(color), el('span', { text: info.name })]),
        el('td', { class: 'num', text: String(info.size) }),
        ladder,
      ]);
    });
  return el('div', { class: 'brief-scroll' }, [
    el('table', { class: 'brief-table' }, [el('thead', {}, head), el('tbody', {}, rows)]),
  ]);
}

function pageSets() {
  return [
    // calcRent(): rent = info.rent[min(count, len) - 1] — count, not completeness.
    p('Rent is charged on a colour, not on a finished set. One card of a colour already '
      + 'charges the first rung.', 'brief-lede'),
    setsTable(),
    rules([
      ['Rent scales with what you hold',
        'Two Fighters charge 3M. You never need the complete set to charge rent.'],
      // zoneFull() in playProperty / moveProperty.
      ['A zone holds its set size and no more',
        'You cannot stack a fourth Fighter as armour. Extra copies stay in your hand or go '
        + 'on a wild\'s other colour.'],
      // receiveProperty(): no zone can be forced past its size any more. It
      // tries the preferred colour, then the fullest legal one, then
      // shiftWildToMakeRoom() — the rearrange you could have made yourself —
      // and only then banks the card and emits `banked_property`.
      ['A property with nowhere to go becomes money',
        'A payment or steal that has no legal zone left first slides one of your own wilds '
        + 'aside to make room. If even that fails, the card is banked at face value instead. '
        + 'No zone is ever pushed past its size.'],
      // playAction 'upgrade'/'foc' require isSetComplete; foc requires 'house'.
      ['Upgrade +3M, FOC +4M',
        'Complete sets only, one of each per set, and FOC needs the Upgrade in place first.'],
      // playerNetWorth() = payable + upgrades; payableCards() excludes upgrades;
      // discardUpgrades() fires whenever the set stops being complete.
      ['Upgrades are not money',
        'They can never be handed over as payment, they do count in your net worth, and they '
        + 'go to the discard the moment the set under them breaks.'],
      ['Wilds', 'A two-colour wild counts as either of its colours. The "any" wild counts as '
        + 'every colour but is worth 0M — that is what you pay for it.'],
      // receiveProperty(): `ordered` puts preferredColor first — every caller
      // passes card.placedColor, the colour it was on before — then the
      // remaining legal colours sorted by DESCENDING zoneCount, and takes the
      // first zone that is not full.
      ['Cards you RECEIVE place themselves',
        'A property handed to you by a payment, a steal or a swap is placed by the engine, '
        + 'not by you. It prefers the colour it was already on, and only then the colour you '
        + 'have most of — so an arriving wild can land somewhere that does NOT finish your '
        + 'set. Move it afterwards: rearranging a wild on your own board is free and costs '
        + 'no play.'],
    ]),
  ];
}

/* ── page: money & paying ────────────────────────────────────────────────── */

function pagePaying() {
  return [
    // payableCards() = bank + properties. Hand is never touched.
    p('You choose what to hand over — out of your bank and your properties. Never out of '
      + 'your hand.', 'brief-lede'),
    rules([
      // playAsMoney() refuses property and wild_property; everything else banks.
      ['Anything but a property banks',
        'Action cards, rent cards and money cards can all be banked for their face value. '
        + 'That is one of your three plays.'],
      // processPayment(): short payments only legal when selected === payable.
      ['Cover it, or hand over everything',
        'Pay at least what is owed, or surrender every card you own — zero-value wilds '
        + 'included. There is no middle.'],
      // payable.length === 0 → emit 'insolvent', nothing changes hands.
      ['You never owe more than you have',
        'With an empty bank and no properties you pay nothing at all, and no debt is carried.'],
      ['No change is given',
        'Overpaying is legal and the surplus is gone. Pick your cards with that in mind.'],
      // propCards path in processPayment → syncSets(payer) → can disarm.
      ['Paying with a property can break your set',
        'It also discards any Upgrade or FOC standing on that set — and it can end a final '
        + 'approach, yours or theirs.'],
    ]),
    note('Tap your bank and property cards to select them; the bar keeps the running total '
      + 'and turns green when it covers the demand.'),
  ];
}

/* ── page: the cards ─────────────────────────────────────────────────────── */

const CARD_ORDER = [
  'chud', 'inspector_general', 'midnight_requisition', 'tdy_orders',
  'finance_office', 'roll_call', 'surge_ops', 'pcs_orders',
  'upgrade', 'foc', 'opsec',
];

const CARD_TITLES = {
  chud: 'THE CHUD CARD', inspector_general: 'Inspector General',
  midnight_requisition: 'Midnight Requisition', tdy_orders: 'TDY Orders',
  finance_office: 'Finance Office', roll_call: 'Roll Call',
  surge_ops: 'Surge Operations', pcs_orders: 'PCS Orders',
  upgrade: 'Upgrade (House)', foc: 'Full Operational Capability',
  opsec: 'OPSEC',
};

// buildDeck() values, verified card by card.
const CARD_VALUES = {
  chud: 4, inspector_general: 5, midnight_requisition: 3, tdy_orders: 3,
  finance_office: 3, roll_call: 2, surge_ops: 1, pcs_orders: 1,
  upgrade: 3, foc: 4, opsec: 4,
};

function cardEntry({ title, value, count, qty, rule, flag, kind }) {
  return el('div', { class: `brief-card${kind ? ` is-${kind}` : ''}` }, [
    el('div', { class: 'brief-card-head' }, [
      el('span', { class: 'brief-card-name', text: title }),
      el('span', { class: 'brief-card-coin', text: `${value}M` }),
      el('span', { class: 'brief-card-qty', text: qty || `×${count}` }),
    ]),
    el('p', { class: 'brief-card-rule', text: rule }),
    el('span', { class: `brief-card-flag is-${flag.kind}`, text: flag.text }),
  ]);
}

function pageCards() {
  const out = [
    p('Face value is what the card is worth in the bank — the strongest cards are also the '
      + 'best money you will never want to spend.', 'brief-lede'),
    el('h5', { class: 'brief-sub', text: 'Rent cards' }),
  ];

  // buildDeck() rent block: five colour pairs ×2, plus ['any'] ×3 at value 3.
  const pairs = [['brown', 'lightblue'], ['pink', 'orange'], ['red', 'yellow'],
    ['green', 'darkblue'], ['base', 'intel']];
  out.push(cardEntry({
    title: 'Rent: a colour pair',
    value: 1,
    // buildDeck() makes RENT_COUNTS.pair of EACH of the five pairs. "×10" read
    // as "ten of this card" next to a list of per-card counts (§P7.20).
    qty: `×${RENT_COUNTS.pair} each · ${RENT_COUNTS.pair * pairs.length} total`,
    rule: 'Charge rent on one of the two colours printed on it — EVERY other player pays. '
      + 'Five pairs exist: ' + pairs.map(pair => pair.map(colorName).join('/')).join(', ') + '.',
    flag: opsecFlag({ type: 'rent' }),
    kind: 'rent',
  }));
  out.push(cardEntry({
    title: 'Rent: Any Colour',
    value: 3,
    count: RENT_COUNTS.any,
    // playAction rent branch, isWildRent: requires targetId, targets = [that player].
    rule: 'Charge rent on any ONE colour you own, from ONE player you name. It does not hit '
      + 'the table — that is what the higher face value buys.',
    flag: opsecFlag({ type: 'rent' }),
    kind: 'rent',
  }));

  out.push(el('h5', { class: 'brief-sub', text: 'Action cards' }));
  for (const action of CARD_ORDER) {
    out.push(cardEntry({
      title: CARD_TITLES[action],
      value: CARD_VALUES[action],
      count: ACTION_COUNTS[action],
      rule: ACTION_RULES[action],
      // One source for the OPSEC sentence — cards.js. The boolean this used to
      // take could not express OPSEC itself, which creates no pendingAction and
      // was therefore flagged "OPSEC CANNOT TOUCH IT" one line under its own
      // counter-OPSEC rule text (§P7.15).
      flag: opsecFlag({ type: 'action', action }),
      kind: action === 'chud' ? 'chud' : '',
    }));
  }
  out.push(note('Upgrade, FOC, Surge Operations and PCS Orders aim at nobody, so there is '
    + 'nothing for an OPSEC to answer. OPSEC itself is answered only by another OPSEC.'));
  return out;
}

/* ── page: OPSEC ─────────────────────────────────────────────────────────── */

/** respondToAction(): each OPSEC splices the card out of hand into the discard,
 *  increments entry.depth and flips entry.responderId. Accepting at an ODD depth
 *  means the defender's OPSEC stood (action_blocked); at an EVEN depth the
 *  target suffers it. */
function opsecChain() {
  const beat = (who, kind, text) => el('li', { class: `op-beat is-${kind}` }, [
    el('span', { class: 'op-who', text: who }),
    el('span', { class: 'op-text', text }),
  ]);
  return el('ol', { class: 'op-chain' }, [
    beat('BLAZE', 'attack', 'plays THE CHUD CARD on your F-22.'),
    beat('YOU', 'defend', 'play OPSEC. The card is spent and discarded. Now Blaze must answer.'),
    beat('BLAZE', 'attack', 'counters with a second OPSEC. Also spent. Back to you.'),
    beat('YOU', 'defend', 'have no third OPSEC, so you let it stand.'),
    beat('RESULT', 'result', 'The CHUD goes through and the F-22 changes hands. '
      + 'Both OPSEC cards are gone either way.'),
  ]);
}

function pageOpsec() {
  return [
    p('OPSEC is the only card you play on someone else\'s turn. It cancels an action aimed '
      + 'at you — and it can be countered.', 'brief-lede'),
    opsecChain(),
    rules([
      ['Whoever stops countering loses',
        'The chain ends when one side declines. If that is the attacker, the action is '
        + 'blocked; if it is you, it resolves in full.'],
      ['Every OPSEC played is spent',
        'It goes to the discard the moment you play it, win or lose the exchange.'],
      // startPending() builds one entry per target; each has its own depth chain.
      ['One chain per target',
        'Roll Call and colour rent charge the whole table, and each player answers alone. '
        + 'Your OPSEC protects you and nobody else.'],
      ['It cannot pre-empt',
        'You play it in response to a card already on the table, never ahead of one.'],
      // playAction: discardAndSpend() runs BEFORE startPending(), so the card
      // and the play are gone the instant it is played; chargeAmount() deletes
      // state._surgeOps at that same moment. A block refunds none of it.
      ['A blocked attack still costs the attacker everything',
        'Their card was discarded and one of their three plays was spent the moment they '
        + 'played it. If they had Surge Operations running, the doubling was burned on the '
        + 'charge too, and it does not come back. Blocking does not undo the play — it only '
        + 'stops the effect.'],
    ]),
    note('When an OPSEC is standing against you, the bar asks whether to let it stand or '
      + 'counter. "Let it stand" means your own action is cancelled.'),
  ];
}

/* ── page: endings ───────────────────────────────────────────────────────── */

function pageEndings() {
  return [
    p('Three ways a game ends. Only one of them is a race to sets.', 'brief-lede'),
    rules([
      // finishGame(state, id, 'sets', …) from resolveFinalApproach().
      ['Final approach converted',
        `An armed player reaches their own turn start still holding ${SETS_TO_WIN} complete `
        + 'sets. The usual ending.'],
      // scoop() → activePlayers.length === 1 → finishGame(…, 'last_standing').
      ['Last one standing',
        'Scooping discards everything you own and takes you out for good. If everyone else '
        + 'scoops, the survivor wins on the spot — no cycle, no checkpoint.'],
      // endInStalemate(): ranked by completedSets, then playerNetWorth, and the
      // sort is stable over `state.players.filter(!eliminated)` — so a dead heat
      // on both numbers is settled by seat order, earliest seat first.
      ['Attrition — decided on points',
        'Most completed sets wins; net worth (bank + properties + upgrades) breaks the tie; '
        + 'and if two players match on both, the earlier seat at the table takes it.'],
    ]),
    el('h5', { class: 'brief-sub', text: 'What triggers attrition' }),
    bullets([
      // endTurn(): _idleTurns >= activeCount when deck and discard are both empty.
      'Deck and discard are both empty and a full round passes with nobody playing a card '
      + 'out of hand.',
      // endTurn(): shuffleCount >= DECK_CYCLE_LIMIT.
      `Or the discard has been reshuffled back into the deck ${DECK_CYCLE_LIMIT} times. `
      + 'The table has had long enough; it goes to points.',
    ]),
    el('h5', { class: 'brief-sub', text: 'What scooping actually does' }),
    bullets([
      // scoop(): hand, bank and every property zone are emptied into discardPile,
      // then discardUpgrades() per colour.
      'Every card you own — hand, bank, properties and upgrades — goes to the discard pile, '
      + 'where it is shuffled back into the deck later. It is not removed from the game.',
      // scoop(): pa.targets filtered by playerId; pendingAction nulled when empty
      // or when the scooper was the source.
      'Any demand pointed at you dies with you. If you were the only target, the attacker\'s '
      + 'card is already spent and they get nothing.',
      // scoop(): activePlayers.length === 1 → finishGame(..., 'last_standing').
      'If you were the second-to-last player in, the survivor wins on the spot — no final '
      + 'approach, no checkpoint. Scooping out of a losing position can hand someone the game.',
      'There is no undo, and you cannot come back in.',
    ]),
    // ui/hud.js renders the chip at cycle >= deckCycleNotice() — 8 of 16.
    // "once the deck has been through it a few times" was unfalsifiable (§P7.20).
    note(`The HUD starts showing the deck-cycle count at ${deckCycleNotice()} of `
      + `${DECK_CYCLE_LIMIT}, and turns it gold in the last two, so an attrition finish is `
      + 'never a surprise.'),
  ];
}

/* ── page: controls ──────────────────────────────────────────────────────── */

function pageControls() {
  return [
    p('Cards are objects. Tap one to see its options — or just throw it where you want it.',
      'brief-lede'),
    rules([
      ['Tap a card in hand',
        'It lifts, and a strip appears above your hand: Play, Bank, Details.'],
      ['DRAG it instead',
        'Pick a card up and drop it where it goes — this is the fast way. Legal landing '
        + 'places light up while you drag.'],
      ['Drop on a set column', 'Places a property, or aims a rent card at that colour.'],
      ['Drop on an opponent\'s board', 'Aims a steal, swap or demand at that player.'],
      ['Drop on your bank', 'Banks the card for its face value.'],
      ['Drop in the middle of the table', 'Means "play it" — you then aim on the table.'],
      ['Drag a wild that is already on your board',
        'Move it to another set column. Free, and as often as you like on your turn.'],
      ['Long-press any card', 'Opens its full rules card, wherever it is on the table.'],
      ['Targeting happens on the table',
        'Eligible boards, columns and cards glow. Tap the one you want.'],
      ['Paying', 'Your bank and properties become selectable. The bar totals what you have '
        + 'picked; confirm when it is enough.'],
      ['Escape', 'Cancels a drag, then a selection, and closes any open sheet.'],
      ['Keyboard', 'Tab moves between controls, Enter or Space activates, Escape backs out.'],
    ]),
    note('Reduced-motion is honoured: cards fade instead of flying, and the sound stays.'),
  ];
}

/* ── the sheet ───────────────────────────────────────────────────────────── */

const PAGES = [
  { id: 'goal', tab: 'Goal', title: 'Goal & final approach', build: pageGoal },
  { id: 'turn', tab: 'Turn', title: 'Your turn', build: pageTurn },
  { id: 'sets', tab: 'Sets', title: 'Sets & rent', build: pageSets },
  { id: 'paying', tab: 'Paying', title: 'Money & paying', build: pagePaying },
  { id: 'cards', tab: 'Cards', title: 'Every action card', build: pageCards },
  { id: 'opsec', tab: 'OPSEC', title: 'OPSEC chains', build: pageOpsec },
  { id: 'endings', tab: 'Endings', title: 'How games end', build: pageEndings },
  { id: 'controls', tab: 'Controls', title: 'Controls', build: pageControls },
];

let current = 'goal';
let host = null;
let rail = null;

/**
 * Centre a tab in its own rail. NOT scrollIntoView: `.sheet-body` computes to
 * `overflow-x: auto` (it declares overflow-y), so scrollIntoView walked up and
 * scrolled the whole sheet sideways — measured on the 390px Controls page, the
 * heading and every bullet marker were clipped off the left edge.
 */
function reveal(tab) {
  if (!rail || !tab) return;
  const want = tab.offsetLeft - (rail.clientWidth - tab.offsetWidth) / 2;
  const max = rail.scrollWidth - rail.clientWidth;
  rail.scrollTo({ left: Math.max(0, Math.min(max, want)), behavior: 'smooth' });
}

function paint() {
  if (!host) return;
  const page = PAGES.find(x => x.id === current) || PAGES[0];
  clear(host);
  host.appendChild(el('h4', { class: 'brief-title', text: page.title }));
  for (const node of page.build()) host.appendChild(node);
  host.scrollTop = 0;
  for (const tab of rail ? rail.children : []) {
    const on = tab.dataset.page === page.id;
    setClass(tab, 'is-on', on);
    setAttr(tab, 'aria-selected', on ? 'true' : 'false');
    setAttr(tab, 'tabindex', on ? '0' : '-1');
  }
}

export function show(pageId) {
  if (pageId && PAGES.some(x => x.id === pageId)) current = pageId;
  rail = el('div', { class: 'brief-tabs', attrs: { role: 'tablist', 'aria-label': 'Rules sections' } },
    PAGES.map(page => el('button', {
      class: 'brief-tab',
      text: page.tab,
      attrs: { role: 'tab', type: 'button' },
      dataset: { action: 'help-page', page: page.id },
    })));
  host = el('div', { class: 'brief-page', attrs: { role: 'tabpanel', tabindex: '0' } });

  // Left/Right walk the rail, as a tablist must (§0.9).
  rail.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = PAGES.findIndex(x => x.id === current);
    const next = PAGES[(i + (e.key === 'ArrowRight' ? 1 : PAGES.length - 1)) % PAGES.length];
    current = next.id;
    paint();
    const on = rail.querySelector('.brief-tab.is-on');
    reveal(on);
    on?.focus({ preventScroll: true });
  });

  openSheet('Mission brief', el('div', { class: 'brief' }, [rail, host]));
  paint();
  reveal(rail.querySelector('.brief-tab.is-on'));
}

export function mount() {
  pointer.registerActions({
    'help-page': (elx) => {
      current = elx.dataset.page || current;
      paint();
      reveal(elx);
    },
  });
}
