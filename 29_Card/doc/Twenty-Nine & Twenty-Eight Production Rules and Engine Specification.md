# Twenty-Nine & Twenty-Eight: Production Rules and Engine Specification

Oct 25, 2026 · @Faisal

## 1. Overview

One rules engine plays both Twenty-Nine and Twenty-Eight, driven entirely by configuration. The default ruleset, `29-standard`, follows common Twenty-Nine practice: counterclockwise play, priority-duel bidding, a face-down trump card, optional trump calling, and pair and double enabled. Two more presets ship: `29-simplified` (a beginner mode that keeps the behaviour of the original draft) and `28-standard`.

**Target platform.** Real-time online play for four players, mostly on phones (iOS and Android). Mobile shapes much of this spec: networks drop, apps go to the background, screens are small and input is touch. Sections 18, 19, 23 and 24 carry those requirements. Bots fill empty seats in casual play only.

**Conformance.** MUST, MUST NOT, SHOULD and MAY follow RFC 2119. A conforming engine implements every MUST for each preset it offers and rejects any configuration it does not support.

**Design principles**

- One engine, many rulesets. Every regional difference is a named configuration key, never a code fork.
- The server is the only authority. Clients send intents; the server validates, applies and sends each seat a filtered view.
- Hidden information never leaves the server unless the viewer is entitled to it. Hiding it in the UI is not enough.
- The engine is a pure function of its state, the action and the shuffled deck, so every hand replays exactly.
- A match's configuration is frozen when the match starts.

**Out of scope for v1:** single-hand (one player plays alone), no-trump contracts, tournament scoring and asynchronous (turn-by-notification) play. Each needs its own specification before it can be enabled.

## 2. Rulesets and configuration

A ruleset is an immutable, versioned configuration object, identified as `<preset>@<semver>` (for example `29-standard@1.0.0`). A match stores a full copy of its ruleset at creation; later edits to a preset never affect running or archived matches.

| Key | What it controls | 29-standard (default) | 29-simplified | 28-standard |
| --- | --- | --- | --- | --- |
| `direction` | Order of dealing, bidding, play and dealer rotation | counterclockwise | clockwise | counterclockwise |
| `lastTrickBonus` | Extra card point for winning trick 8 | 0 | 0 | 0 |
| `totalPoints` (derived) | 28 + `lastTrickBonus` | 28 | 28 | 28 |
| `minBid` | Lowest legal bid | 16 | 16 | 14 |
| `maxBid` (derived) | Equals `totalPoints` | 28 | 28 | 28 |
| `auctionStyle` | Bidding procedure (section 7) | `priorityDuel` | `openAscending` | `openAscending` |
| `openingBidForced` | Eldest hand must open at `minBid` or more | true | true | true |
| `allPassPolicy` | Used only when opening is not forced | `redealSameDealer` | `redealSameDealer` | `redealSameDealer` |
| `partnerOverbidMin` | Lowest bid allowed over your partner's bid | none | none | 20 |
| `secondRound` | Bidding after all eight cards are dealt | off | off | on, `minBid` 24 |
| `trumpIndicator` | How trump is marked (section 8) | `faceDownCard` | `external` | `faceDownCard` |
| `seventhCardTrump` | Declarer may take the 7th card dealt as trump | false | false | false |
| `revealPolicy` | When trump is revealed (section 11) | `optionalOnVoid` | `mandatoryOnFirstVoid` | `optionalOnVoid` |
| `callerMustTrump` | A player who calls for trump must play one if able | true | false | true |
| `declarerRevealPlay` | What declarer must play after revealing | `anyTrump` | `anyCard` | `indicatorCard` |
| `declarerMayLeadHiddenTrump` | Declarer may lead trump before it is revealed | false | true | false |
| `revealTrickSemantics` | Which cards in the reveal trick carry trump power | `fromRevealPosition` | `wholeTrick` | `fromRevealPosition` |
| `doubling` | Double and redouble (section 9) | on, after full deal | off | off |
| `pair` | King-queen of trump adjusts target (section 13) | on: 4, floor 16, ceiling 28 | off | off |
| `scoreBands` | Game points by final bid (section 14) | 16–28: +1 / −1 | 16–28: +1 / −1 | 14–19: +1 / −2; 20–28: +2 / −3 |
| `matchEnd` | Thresholds that end the match | +6 / −6 | +6 / −6 | +6 / −6 (house default) |
| `redealOnPointlessFour` | Player with 0 points in first four cards may ask for a redeal | false | false | false |
| `redealDealer` | Who deals after a redeal | `sameDealer` | `sameDealer` | `sameDealer` |

**Configuration validation.** The engine MUST refuse to start a match whose configuration breaks any of these rules:

- `declarerRevealPlay = indicatorCard` and `seventhCardTrump = true` require `trumpIndicator = faceDownCard`.
- `secondRound.minBid` must be greater than `minBid` and no more than `maxBid`.
- `pair.floor` ≥ `minBid` and `pair.ceiling` ≤ `totalPoints`.
- `scoreBands` must cover every integer from `minBid` to `maxBid` exactly once.
- `matchEnd.winAt` > 0 > `matchEnd.loseAt`.

The `29-standard` preset as stored:

```json
{
  "rulesetId": "29-standard@1.0.0",
  "direction": "counterclockwise",
  "lastTrickBonus": 0,
  "minBid": 16,
  "auctionStyle": "priorityDuel",
  "openingBidForced": true,
  "allPassPolicy": "redealSameDealer",
  "partnerOverbidMin": null,
  "secondRound": { "enabled": false },
  "trumpIndicator": "faceDownCard",
  "seventhCardTrump": false,
  "revealPolicy": "optionalOnVoid",
  "callerMustTrump": true,
  "declarerRevealPlay": "anyTrump",
  "declarerMayLeadHiddenTrump": false,
  "revealTrickSemantics": "fromRevealPosition",
  "doubling": { "enabled": true, "timing": "afterFullDeal", "stakes": [1, 2, 4] },
  "pair": { "enabled": true, "adjustment": 4, "floor": 16, "ceiling": 28, "windowMs": 4000 },
  "scoreBands": [{ "from": 16, "to": 28, "win": 1, "loss": 1 }],
  "matchEnd": { "winAt": 6, "loseAt": -6 },
  "redealOnPointlessFour": false,
  "redealDealer": "sameDealer"
}
```

## 3. Cards and deck

The deck has 32 unique cards: eight ranks in each of four suits, no jokers, worth 28 card points in total (7 per suit). Ranking is the same in every suit and in trump: J > 9 > A > 10 > K > Q > 8 > 7. Do not use poker or bridge ranking.

| Rank | ID char | Strength | Card points |
| --- | --- | --- | --- |
| Jack | `J` | 8 | 3 |
| Nine | `9` | 7 | 2 |
| Ace | `A` | 6 | 1 |
| Ten | `T` | 5 | 1 |
| King | `K` | 4 | 0 |
| Queen | `Q` | 3 | 0 |
| Eight | `8` | 2 | 0 |
| Seven | `7` | 1 | 0 |

**Card IDs.** A card's ID is its rank character followed by its suit character: `C` clubs, `D` diamonds, `H` hearts, `S` spades. Examples: `JS` is the jack of spades, `TH` the ten of hearts. IDs are stable across the whole system: engine, network, logs and tests.

**Suit order.** Suits have no rank relative to each other. Clients MAY sort a hand for display (for example alternating colours), but display order MUST NOT affect any rule.

**Card points vs game points.** Card points are captured in tricks during a hand. Game points are the match score. They are separate quantities and MUST be stored in separate fields.

## 4. Seats, direction and partnerships

Four seats are numbered by physical position, clockwise, and partners sit opposite. Every "next player" in the rules means `next(seat)` in the configured direction, so one function covers both games.

```
Seats (physical, clockwise):  0 = North, 1 = East, 2 = South, 3 = West
Team A = {0, 2}    Team B = {1, 3}

partner(s) = (s + 2) mod 4
team(s)    = (s mod 2 == 0) ? A : B
next(s)    = direction == clockwise ? (s + 1) mod 4 : (s + 3) mod 4
eldest(d)  = next(d)    // first to receive cards, first to bid, first to lead
```

With counterclockwise play, `eldest` is the dealer's right-hand player; with clockwise play it is the dealer's left. The rules never say "left" or "right" directly; they always use `next()`.

**First dealer.** Chosen uniformly at random by the server's CSPRNG when the match starts.

**Dealer rotation.** After each scored hand, `dealer = next(dealer)`. A redealt hand follows `redealDealer` (section 16).

**Fixed seats.** Players and partnerships do not change during a match. A disconnected player keeps their seat; a bot plays it in the meantime (section 19).

## 5. Hand lifecycle and state machine

Every hand passes through the same ordered phases; the ruleset only decides which optional phases run. The engine MUST reject any command that does not belong to the current phase (`WRONG_PHASE`).

&#91;embedded content: hand lifecycle · 11 phases, 2 loops\]

A voided deal returns to phase 1 with a fresh shuffle and, by default, the same dealer. Trump revelation and the pair window are transitions inside play, not separate phases. The match itself moves from `IN_PROGRESS` to `FINISHED` or `ABANDONED` and never back.

## 6. Shuffle and deal

Each hand uses one fresh server-side shuffle, dealt in two packets of four cards per player. There is no kitty, stock or cut.

**Shuffle.** The server MUST shuffle the 32 card IDs with Fisher–Yates driven by a cryptographically secure RNG (for example Node `crypto.randomInt`, Go `crypto/rand`, Java `SecureRandom`). It MUST NOT use `Math.random`, time-based seeds or any client-supplied randomness. Every redeal gets a new shuffle.

**Deal order.** Starting with `eldest(dealer)` and moving by `next()`, deal positions 0–15 of the shuffled deck as four consecutive cards to each player (phase 1). After trump selection, deal positions 16–31 the same way (phase 2). Each player's cards are numbered 1–8 in the order received; the "seventh card" (section 8) is the third card of their second packet.

**Delivery rules**

- Each seat receives only its own cards, in a private event.
- Phase-2 cards MUST NOT reach any client, cache or log readable by clients before the phase-2 deal. The full deck order exists only on the server.
- Other seats learn only card counts.

**Cards per location after the deal**

| Ruleset setting | Declarer | Each other player |
| --- | --- | --- |
| `faceDownCard` | 7 in hand + 1 concealed | 8 in hand |
| `external` | 8 in hand | 8 in hand |

## 7. Auction

The auction decides the declarer and the contract: the minimum card points the declarer's team promises to capture. Twenty-Nine uses a priority duel; Twenty-Eight and the simplified preset use an open ascending auction, and Twenty-Eight adds a second round after the full deal.

### 7.1 Rules common to all auctions

- A bid is an integer from `minBid` to `maxBid`. It is a team target, not an individual one.
- A pass is permanent for that auction round.
- If `partnerOverbidMin` is set, a bid over your partner's standing bid must be at least that value.
- **Auto-pass.** When a player to act has no legal bid (for example the bid stands at `maxBid`), the engine records a pass for them at once, flagged `auto: true`. No player is ever asked for an impossible action.
- The auction's result is `declarer` (the final high bidder) and `originalContract` (the final bid).

### 7.2 Priority duel (29-standard)

Bidding is a series of duels. The **holder** is the player earlier in bidding order and has priority: they may *hold*, which means matching the current bid. The **challenger** must bid strictly higher. A duel ends when either passes; the survivor becomes holder against the next player who has not yet spoken. The survivor of the dealer's duel is declarer.

```
order = [eldest, next(eldest), next(next(eldest)), dealer]

if openingBidForced:
    order[0] must BID x with minBid ≤ x ≤ maxBid
    holder = order[0]; current = x; i = 1
else:
    first player in order to BID becomes holder; earlier players are out
    if all four pass → apply allPassPolicy

while i < 4:
    challenger = order[i]
    loop:
        challenger: BID y > current            → current = y; high = challenger
                    PASS                       → break
        holder:     HOLD (y = current) or BID y > current → high = holder
                    PASS                       → holder = challenger; break
    i = i + 1

declarer = holder; originalContract = current
```

**Example.** P1 (eldest) opens 16. P2 bids 17; P1 holds 17. P2 bids 18; P1 passes. P2 now holds against P3, who passes. P2 meets P4 (dealer): P4 bids 19, P2 holds 19, P4 passes. P2 is declarer at 19.

**At the maximum.** A holder may hold at `maxBid`. A challenger facing `maxBid` has no legal bid and is auto-passed, so the auction finishes without further prompts.

Partners can meet in a duel (for example P1 against P3 after P2 passes). That is legal.

### 7.3 Open ascending (29-simplified, Twenty-Eight first round)

Starting with `eldest` and moving by `next()`, each active player either bids higher than the current bid or passes. The auction ends as soon as every player except the high bidder has passed.

```
active = all four seats; current = null; high = null; turn = eldest
if openingBidForced: eldest must BID ≥ minBid
repeat:
    if turn == high: end auction
    turn: BID y with y > current, y ≥ minBid, partner rule satisfied → current = y; high = turn
          PASS → remove turn from active
    turn = next active seat after turn
```

In Twenty-Eight, `partnerOverbidMin = 20`: you may bid over your partner's standing bid only with 20 or more.

### 7.4 Twenty-Eight second round

After the phase-2 deal, every player gets another chance, now seeing all eight cards. First-round passes do not carry over.

```
current = originalContract; lastBidder = null; active = all four; turn = eldest
repeat:
    if turn == lastBidder: end
    if active is empty: end            // all passed, contract unchanged
    turn: BID y ≥ max(secondRound.minBid, current + 1) → current = y; lastBidder = turn
          PASS → remove from active
    turn = next active seat
```

Outcome:

- No bid: contract and trump are unchanged.
- The current declarer wins the round: the contract rises; trump is unchanged.
- Anyone else wins (including the declarer's partner): the old concealed card goes back, unseen, into the old declarer's hand. The winner becomes declarer and selects trump from their eight cards (section 8.4). The contract becomes the new bid.

### 7.5 All-pass and invalid input

- With `openingBidForced = true` (every shipped preset) an auction always produces a declarer.
- With forced opening off and four passes, `allPassPolicy = redealSameDealer`: the hand is void, nothing is scored, and the same dealer deals a fresh shuffle.
- A non-integer bid, a bid outside `minBid`–`maxBid`, a bid that is not high enough, or a hold by a challenger is rejected with an error to that player only; state does not change.

## 8. Trump selection and the concealed card

The declarer chooses trump secretly, after the auction and before the phase-2 deal, while holding only four cards. In both standard presets trump is marked by a real card placed face down; that card stays one of the declarer's eight cards and is played in some trick.

### 8.1 Face-down card (`faceDownCard`, default)

1. The declarer chooses one of their four cards. Its suit is trump, so trump must be a suit the declarer holds.
2. The card moves from the hand to the `concealedTrumpCard` location. Everyone sees that a face-down card exists and who owns it; only the declarer knows what it is.
3. After the phase-2 deal the declarer has seven cards in hand and one concealed.

While concealed, the card:

- is not in the declarer's hand and cannot be played;
- is ignored by follow-suit checks (a declarer whose only card of the led suit is the concealed card counts as void);
- returns to the declarer's hand the moment trump is revealed (section 11);
- is revealed automatically at the start of trick 8 if still hidden, because it is then the declarer's only card (section 11.5).

### 8.2 External indicator (`external`, simplified preset)

The declarer chooses any of the four suits, whether or not they hold it. The suit is stored on the server; no card moves. The declarer keeps all eight cards in hand.

### 8.3 Seventh card (optional, `seventhCardTrump`)

Instead of choosing a card, the declarer may announce "seventh card". After the phase-2 deal, the declarer's seventh card (third card of the second packet) goes straight to `concealedTrumpCard` without being shown to anyone, the declarer included. Trump is then unknown to all four players until revealed, so the lead restriction in section 10.2 does not apply to that hand.

### 8.4 Twenty-Eight reselection

When a different player wins the second round (section 7.4), the old concealed card returns face down to the old declarer's hand, and no one is told its identity. The new declarer chooses one of their eight cards as the new concealed card, leaving seven in hand.

### 8.5 Who knows trump

| Situation | Declarer | Declarer's partner | Defenders |
| --- | --- | --- | --- |
| Before revelation | Knows (except seventh card) | Does not know | Do not know |
| After revelation | Knows | Knows | Know |
| Hand ended unrevealed | Disclosed to all in the hand summary | Disclosed | Disclosed |

The server MUST NOT send the trump suit or the concealed card's identity to any seat that is not entitled to it, including the declarer's partner. If the declarer times out, the server chooses for them (section 19).

## 9. Doubling and redoubling

In `29-standard` the defenders may double after all eight cards are dealt, and the declaring team may then redouble; stakes are 1, 2 or 4 game points. Doubling is off in the other presets.

**Timing.** `doubling.timing = afterFullDeal` (default) runs this phase after the phase-2 deal and before trick 1. The alternative `beforeSecondDeal` runs it after trump selection, when players hold four cards.

**Order**

1. Defender `next(declarer)`, then their partner, each choose DOUBLE or PASS. The first double ends this step.
2. If doubled: the declarer, then the declarer's partner, each choose REDOUBLE or PASS. The first redouble ends this step.
3. If no one doubles, the stake stays 1.

**Effect.** `stakeMultiplier` becomes 2 after a double and 4 after a redouble. It multiplies game points only (section 14). It never changes card points or the contract.

All doubling decisions are public. A player who times out passes.

## 10. Trick play and legal moves

A hand is always eight tricks. `eldest(dealer)` leads trick 1 whoever the declarer is; play moves by `next()`; each player plays exactly one card; the trick's winner leads the next trick.

### 10.1 Following suit

A player holding any card of the led suit in hand MUST play one. The concealed trump card is not in hand and never counts. A player void in the led suit may play any card, subject to the trump rules in section 11.

There is no general duty to beat the winning card, to trump, to overtrump or to avoid undertrumping. The only extra obligations are the ones a player takes on by revealing trump (`callerMustTrump`, `declarerRevealPlay`).

### 10.2 Leading

Any card in hand may be led, with one exception. While trump is hidden, a declarer who knows trump MUST NOT lead a trump-suit card if they hold any other card, unless `declarerMayLeadHiddenTrump = true`. A declarer holding only trump-suit cards when it is their lead must reveal trump and then lead any trump.

The restriction applies only to the declarer, because no one else knows trump.

### 10.3 Legal-move function

The server computes legal actions with this function, sends the result privately to the player to act, and rejects anything outside it.

```
legalActions(p):
    hand = hands[p]                       // never includes the concealed card
    T = trumpSuit

    // A. Leading
    if trick is empty:
        if p == declarer and !trumpRevealed and declarerKnowsTrump
           and !cfg.declarerMayLeadHiddenTrump:
            others = hand where suit != T
            return others nonempty ? PLAY(others) : [REVEAL_TRUMP]
        return PLAY(hand)

    // B. Following
    led = trick.ledSuit
    follow = hand where suit == led
    if follow nonempty: return PLAY(follow)

    // C. Void, trump already public
    if trumpRevealed:
        if p revealed trump during this turn: return PLAY(afterReveal(p))
        return PLAY(hand)

    // D. Void, trump still hidden
    reveal = (p == declarer) ? REVEAL_TRUMP : CALL_TRUMP
    if cfg.revealPolicy == mandatoryOnFirstVoid: return [reveal]
    return PLAY(hand) + [reveal]

afterReveal(p):                           // hand now includes the returned concealed card
    follow = hand where suit == led
    if follow nonempty: return follow     // trump was led and the returned card follows suit
    if p == declarer:
        indicatorCard → [the returned concealed card]
        anyTrump      → hand where suit == T        // never empty
        anyCard       → hand
    else:
        trumps = hand where suit == T
        return (cfg.callerMustTrump and trumps nonempty) ? trumps : hand
```

When the declarer must reveal before leading (branch A), the lead after revealing may be any trump in hand, including the returned card.

## 11. Trump revelation

Trump becomes public at most once per hand and never goes back into hiding. In the standard presets a player void in the led suit chooses whether to reveal it; in the simplified preset the first void player must.

### 11.1 Who can reveal, and when

| Policy | Non-declarer void in led suit | Declarer void in led suit |
| --- | --- | --- |
| `optionalOnVoid` (standard) | Discard any card, or CALL\_TRUMP | Discard any card, or REVEAL\_TRUMP |
| `mandatoryOnFirstVoid` (simplified) | Must CALL\_TRUMP before playing | Must REVEAL\_TRUMP before playing |

The declarer may also be forced to reveal when leading with only trump-suit cards in hand (section 10.2). No one can reveal when they can follow suit or when it is not their turn.

### 11.2 Reveal procedure

The server performs these steps as one atomic transition:

1. Check that trump is hidden, it is the actor's turn, and a reveal is legal for them.
2. Set `trumpRevealed = true` and record `revealedBy`, `revealTrickIndex` and `revealPosition` (the number of cards already in the current trick, 0–3).
3. With `faceDownCard`: move the concealed card into the declarer's hand and show it face up to everyone.
4. Broadcast `TRUMP_REVEALED` with the suit (and the card, if any) to all seats.
5. The revealer now plays from `afterReveal()` (section 10.3).

### 11.3 Obligations after revealing

- A non-declarer who called MUST play a trump if they hold one (`callerMustTrump = true`); otherwise any card.
- A declarer who revealed plays according to `declarerRevealPlay`: any trump (29-standard), specifically the returned card (28-standard), or any card (simplified).
- In both cases, if the returned card makes the player able to follow suit, they must follow suit first.
- From the next player onward, ordinary rules apply: a void player may play any card.

### 11.4 Earlier tricks

Completed tricks are never re-evaluated. A trump-suit card played before revelation won or lost as an ordinary card, and that result stands.

### 11.5 Final trick

With `faceDownCard`, if trump is still hidden when trick 8 begins, the server reveals it automatically before the lead (`revealedBy = system`, `revealPosition = 0`). The declarer's last card is the concealed card, so it must enter play. Every player holds exactly one card at that point, so revealing early gives no one a choice they did not already have.

With `external`, trump may stay hidden for the whole hand. All eight tricks are then decided by the led suit, and the suit is disclosed in the hand summary without changing any result.

## 12. Trick resolution

The highest trump with trump power wins; if there is none, the highest card of the led suit wins. A card of any other suit can never win. Cards are unique, so ties cannot occur.

```
trickWinner(trick):
    led = trick.cards[0].suit
    powered = cards where suit == T and suit != led and hasTrumpPower(position)
    if powered nonempty: return highest strength in powered
    return highest strength among cards where suit == led

hasTrumpPower(position):
    if trump not revealed by the end of this trick: false
    if trump revealed before this trick began:       true
    // revealed during this trick
    fromRevealPosition → position >= revealPosition
    wholeTrick         → true
```

**When trump is led**, every trump-suit card in the trick is a led-suit card and they compare by rank alone. Reveal timing then makes no difference, which closes the gap in the original draft where a lower trump played after the reveal could have beaten a higher one led before it.

**Why `fromRevealPosition` is the default.** Under optional revelation, a void player can discard a trump-suit card without calling. That card must stay a discard even if a later player in the same trick calls for trump. Under `wholeTrick` it would gain power retroactively.

**Points.** The winner's team adds the card points of all four cards. If this is trick 8 and `lastTrickBonus = 1`, it adds 1 more.

**Worked examples** (P1 leads; spades are trump; `fromRevealPosition`)

| # | P1 | P2 | P3 | P4 | Reveal | Winner | Why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | H A | S J (void, no call) | S 7 (void, calls) | H J | P3, position 2 | P3 | S 7 has power; S J came before the reveal and is a discard. Under `wholeTrick`, P2 would win. |
| 2 | S A (trump hidden) | D 9 (void, calls) | S 7 | S J | P2, position 1 | P4 | Trump was led, so spades compare by rank. |
| 3 | H 10 | S J (void, no call) | H 7 | H K | None | P1 | No trump power without a reveal. The 10 is the highest heart: it outranks the K. |
| 4 | C A | S 7 | S 9 | C J | Earlier trick | P3 | Both spades have power; 9 beats 7. |

Example 1 gives P3's team 7 card points (A 1 + J 3 + 7 0 + J 3).

## 13. Pair (king and queen of trump)

In `29-standard`, a player holding both the king and queen of trump may declare a pair once trump is public, right after their team wins a trick. A pair by the declaring team lowers the target by 4 (not below 16); a pair by the defenders raises it by 4 (not above 28).

### 13.1 Eligibility

A player may DECLARE\_PAIR only when all of these hold:

1. Trump has been revealed.
2. Both the king and the queen of trump are in that player's hand now (the declarer's returned concealed card counts once it is back in hand).
3. The trick just completed was won by that player's team. It may be the trick in which trump was revealed.
4. No pair has been declared this hand. Only one trump K–Q exists, so there is at most one pair per hand.

A player who misses one window may declare at any later window in which conditions 1–4 still hold.

### 13.2 Window

After every completed trick from the reveal trick to trick 7, the server first declares an eligible pair automatically for a player whose `autoDeclarePair` setting is on (the default, section 24.3). It then holds a pair window of `pair.windowMs` (default 4000 ms, sized for phone reaction times) before accepting the next lead, but only if a seat on the team that won the trick has `autoDeclarePair` off.

- Whether a window opens depends only on players' settings, never on their cards. A pause only when someone held a pair would leak that fact.
- Only eligible players receive the DECLARE\_PAIR action. Everyone else sees a neutral "next trick starting" state.
- Declining does not shorten the window, for the same reason. A declaration ends it at once, because declarations are public.
- No window follows trick 8; no cards remain.

With default settings no window ever opens, so play never pauses. If someone opts out, their team's tricks pause for at most about 28 seconds per hand in total.

### 13.3 Effect

```
if declaring team declared: effectiveContract = max(pair.floor,   effectiveContract − pair.adjustment)
if defending team declared: effectiveContract = min(pair.ceiling, effectiveContract + pair.adjustment)
```

The server shows both cards face up to all seats and broadcasts `PAIR_DECLARED`. The cards stay in hand and are played normally. Card values and captured points do not change; only `effectiveContract` does. `originalContract` keeps the winning bid for scoring bands (section 14).

## 14. Hand scoring

The declaring team succeeds if its captured card points are at least the effective contract; meeting it exactly is a success. Only the declaring team's game score changes, so scoring is not zero-sum.

```
declaringPoints = card points in tricks won by declaring team
                  + lastTrickBonus if declaring team won trick 8
defendingPoints = totalPoints − declaringPoints          // assert both sum to totalPoints

made  = declaringPoints >= effectiveContract
band  = the scoreBands entry containing originalContract   // final bid; not pair-adjusted
delta = made ? +band.win × stakeMultiplier : −band.loss × stakeMultiplier

gameScores[declaringTeam] += delta                       // defenders unchanged
```

All eight tricks are always played, even when the result is already certain. A later pair can still move the target, and the invariants in section 21 depend on complete hands. Clients MAY show a "contract secured" or "contract lost" badge once it is certain.

**Examples**

| Ruleset | Final bid | Stake | Pair | Declaring team captured | Result | Declaring team game points |
| --- | --- | --- | --- | --- | --- | --- |
| 29-standard | 18 | 1 | None | 17 | Fail | −1 |
| 29-standard | 18 | 1 | None | 18 | Made (exact) | +1 |
| 29-standard | 20 | 2 (doubled) | None | 22 | Made | +2 |
| 29-standard | 20 | 4 (redoubled) | None | 19 | Fail | −4 |
| 29-standard | 20 | 1 | Declaring team: target 16 | 17 | Made | +1 |
| 29-standard | 26 | 1 | Defenders: target 28 (capped) | 27 | Fail | −1 |
| 28-standard | 21 | 1 | n/a | 21 | Made | +2 |
| 28-standard | 17 | 1 | n/a | 15 | Fail | −2 |

**Hand summary.** After scoring, the server broadcasts `HAND_SCORED` with every trick, both point totals, the trump suit and the concealed card, the contract, any pair, the stake and the score change. All information hidden during the hand is disclosed at this point.

## 15. Match end and dealer rotation

Both teams start at 0 game points. The match ends the moment a team reaches `matchEnd.winAt` (+6) or `matchEnd.loseAt` (−6); otherwise the deal passes to `next(dealer)`.

```
after HAND_SCORED:
    s = gameScores[declaringTeam]
    if s >= winAt:  winner = declaringTeam
    if s <= loseAt: winner = opponents(declaringTeam)
    if winner: emit MATCH_ENDED; status = FINISHED; accept no further game actions
    else:      dealer = next(dealer); start next hand
```

- Use `>=` and `<=`, never equality: doubled stakes and Twenty-Eight bands can jump past a threshold.
- Only the declaring team's score changes, so at most one team can cross a threshold in a hand.
- Voided hands (section 16) never score and do not rotate the dealer under `redealDealer = sameDealer`.
- An abandoned match ends with `status = ABANDONED` and no winner (section 19).

## 16. Redeals

A voided deal scores nothing, is reshuffled from scratch and, by default, is dealt again by the same dealer. In the shipped presets only a server fault can void a deal, because opening is forced and the pointless-four option is off.

| Trigger | When it applies | Who acts |
| --- | --- | --- |
| All four pass | `openingBidForced = false` only | Automatic |
| Pointless first four | `redealOnPointlessFour = true`; a player's first four cards hold 0 card points | That player sends REQUEST\_REDEAL during the redeal window |
| Server fault | An invariant check fails mid-hand (section 21) | Automatic; logged as an incident |

**Redeal window.** With `redealOnPointlessFour` on, the server holds a fixed `redealWindowMs` (default 3000 ms) after the phase-1 deal for every hand, whatever the cards. A pause only when someone qualified would leak that fact.

**Procedure.** Discard all cards, emit `DEAL_VOIDED` with the reason, increment `dealNumber` (not `handNumber`), reshuffle with fresh randomness, and deal again. The dealer stays the same under `redealDealer = sameDealer`, or moves to `next(dealer)` under `rotate`.

## 17. Hidden information and visibility

The server builds a separate view for each seat and sends only what that seat may know; no client ever receives full game state. Bots get exactly the same filtered view as humans.

| Information | Owner | Partner | Opponents | Spectators | Becomes public |
| --- | --- | --- | --- | --- | --- |
| Cards in hand | Yes | Count only | Count only | Count only | Hand summary |
| Phase-2 cards | After phase-2 deal | No | No | No | Hand summary |
| Trump suit | Declarer (not with seventh card) | No | No | No | On reveal |
| Concealed card identity | Declarer (not with seventh card) | No | No | No | On reveal |
| That a concealed card exists, and its owner | Yes | Yes | Yes | Yes | Always |
| Bids, passes, doubles, calls, reveals | Yes | Yes | Yes | Yes | Always |
| Legal actions and error messages | Actor only | No | No | No | Never |
| Cards played to tricks | Yes | Yes | Yes | Yes | Always |
| Pair holding | Holder | No | No | No | On declaration |
| Shuffled deck order | No | No | No | No | Audit only (section 22) |

**Table settings (not rules).** `trickHistoryVisibility` is `all` (default for casual tables) or `lastTrick` (closer to the physical game, for competitive tables). `showCapturedPoints` is true for casual tables and false for competitive ones.

**Side channels the implementation MUST close**

- **Timing.** Pair and redeal windows have fixed lengths and open whatever the cards (sections 13, 16). Bot response delays come from a fixed random distribution, not from how hard the decision was. Auto-played and preselected cards use the same distribution (section 24.3).
- **Client UI.** No trump highlighting, sorting or hints for anyone but the declarer before the reveal. The declarer's partner gets nothing that depends on trump.
- **Errors.** Rejections go to the actor only, and their text never mentions other players' cards.
- **Endpoints and logs.** No debug or admin endpoint is reachable by players in production. Client logs and analytics carry only that client's view.
- **Reconnects.** A reconnecting client receives the same filtered snapshot it would have had all along (section 19).

**Spectators** see public information only. Ranked tables SHOULD delay the spectator stream by one trick to discourage relaying to a player. Partners talking outside the game cannot be prevented technically; ranked play MAY add statistical collusion detection.

## 18. Server architecture, actions and events

Each match is owned by a single-writer match actor that runs a pure rules engine. Clients send commands over a WebSocket; the actor validates and applies them one at a time, appends the resulting events to a log, and pushes each seat its filtered events.

### 18.1 Components

1. **Client** renders its seat's view and sends commands. It MAY run the engine's legal-move function for instant feedback, but the server decides.
2. **Gateway** terminates TLS, authenticates, rate-limits and routes to the match actor. It derives the seat from the session and never trusts a seat sent by the client.
3. **Match actor** is the only writer for its match. It processes commands strictly in order and holds the current state.
4. **Engine** is a pure library: `apply(state, command, deck?) → (state, events)` and `view(state, seat) → SeatView`. It does no I/O and reads no clock. Timeouts arrive as `TIMEOUT` commands from a scheduler, so the log replays exactly.
5. **Event store and snapshots** persist the log and a snapshot at the start of every hand (section 22).
6. **Bot service** plays empty or abandoned seats through the same command API and filtered view.

### 18.2 Command envelope

```json
{
  "commandId": "8d1e6c2a-3f0b-4b7e-9a51-2c6f0e4d7a19",
  "matchId": "m_01J9ZQ3K8Y",
  "expectedVersion": 57,
  "type": "PLAY_CARD",
  "payload": { "cardId": "JS" }
}
```

- `commandId` is an idempotency key. A repeated ID returns the original result and is not applied twice.
- `expectedVersion` is the state version the client last saw. A mismatch returns `STALE_STATE` with a fresh snapshot.
- Every rejection leaves state unchanged and goes only to the sender.

### 18.3 Commands

| Command | Payload | Phase | Who may send |
| --- | --- | --- | --- |
| `BID` | `amount` | Auction, second round | Player to act |
| `HOLD` | none | Auction (`priorityDuel`) | Holder only |
| `PASS` | none | Auction, second round | Player to act |
| `SELECT_TRUMP` | `cardId`, or `suit`, or `seventhCard: true` | Trump selection | Declarer |
| `DOUBLE` / `REDOUBLE` / `PASS_DOUBLE` | none | Doubling | Player to act |
| `PLAY_CARD` | `cardId` | Play | Player to act |
| `CALL_TRUMP` | none | Play | Non-declarer void in led suit |
| `REVEAL_TRUMP` | none | Play | Declarer, when legal |
| `DECLARE_PAIR` | none | Pair window | Eligible player |
| `REQUEST_REDEAL` | none | Redeal window | Eligible player |
| `GET_VIEW` | none | Any | Any seated player or spectator |
| `TIMEOUT` | `seat` | Any | Scheduler only (internal) |

**Session commands** (connection-level, not game moves):

| Command | Payload | Purpose |
| --- | --- | --- |
| `HELLO` | `protocolVersion`, auth token | First message on every connection; answered with `UPGRADE_REQUIRED` if the version is too old |
| `RESUME` | `matchId`, last `seq` received | Replays missed events, or sends a snapshot if they are no longer buffered |
| `PRESENCE` | `foreground` or `background` | Lets the server mark the seat before the socket drops |
| `SET_PREFERENCES` | Automation settings (section 24.3) | Takes effect from the next decision |

### 18.4 Events

Every event carries `eventId`, `matchId`, the global state `version`, a per-recipient `seq` (contiguous for each recipient, because private events to other seats leave gaps in `version`), a server timestamp and an `audience` (all seats, or one seat).

| Event | Audience | Key fields |
| --- | --- | --- |
| `MATCH_STARTED` | All | Seats, teams, ruleset copy, first dealer |
| `HAND_STARTED` | All | `handNumber`, `dealNumber`, dealer |
| `CARDS_DEALT` | One seat | Phase (1 or 2), that seat's cards |
| `TURN` | All | Seat to act, remainingMs, absolute deadline |
| `LEGAL_ACTIONS` | One seat | The actor's legal commands and cards |
| `BID_MADE` / `BID_HELD` / `PASSED` | All | Seat, amount, `auto` |
| `AUCTION_WON` | All | Declarer, contract, round |
| `TRUMP_SELECTED` | All; declarer gets suit and card | Declarer; private: suit, card |
| `DOUBLED` / `REDOUBLED` / `DOUBLE_PASSED` | All | Seat, new stake |
| `CARD_PLAYED` | All | Seat, card, trick index, position |
| `TRUMP_CALLED` | All | Seat |
| `TRUMP_REVEALED` | All | Suit, card, by, trick index, position |
| `TRICK_WON` | All | Winner, card points, trick index |
| `PAIR_WINDOW_OPENED` / `PAIR_DECLARED` | All | Window end time; seat, cards, new target |
| `HAND_SCORED` | All | Full hand summary (section 14) |
| `DEAL_VOIDED` | All | Reason |
| `MATCH_ENDED` | All | Winner, final scores, or abandoned |
| `PLAYER_DISCONNECTED` / `PLAYER_RECONNECTED` / `BOT_TOOK_OVER` | All | Seat |

Clients apply events in `seq` order and send the latest `version` they saw as `expectedVersion`. On a `seq` gap, they discard pending events and request `GET_VIEW`.

## 19. Timers, disconnects and bots

Every decision has a deadline and a defined default, so a slow or vanished player can never stall a table. All limits below are table settings, not rules, and are stored with the match.

### 19.1 Turn timers

| Decision | Default limit | On timeout |
| --- | --- | --- |
| Bid, hold or pass | 20 s | Pass. A forced opener bids `minBid`. |
| Trump selection | 20 s | Pick the suit with the most card points among the four cards (ties: more cards, then the highest card). Place that suit's lowest card face down. With `external`, store that suit. |
| Double or redouble | 10 s | Pass |
| Play a card | 20 s | Play the lowest-strength legal card. Reveal trump only if revealing is the only legal action. |
| Pair window | Fixed `pair.windowMs` | Declared automatically if the seat has autoDeclarePair on (the default) or is a bot; otherwise nothing |
| Redeal window | Fixed `redealWindowMs` | No request |

The server stores each deadline as an absolute server time and sends it in the `TURN` event together with `remainingMs`. Clients count down `remainingMs` on their monotonic clock (section 24.4).

**Time bank.** Phone players get interrupted, so each player has `timeBankMs` (default 30 s per match) for bids, trump selection, doubling and card play. When a turn timer runs out, the bank is used automatically and the server sends an updated `TURN`. Once both are spent, the scheduler sends a `TIMEOUT` command and the engine applies the default above. A command arriving after the deadline is rejected with `TURN_EXPIRED`.

### 19.2 Disconnects and reconnects

- A seat is marked disconnected when its socket closes or two heartbeats (sent every 10 s) are missed.
- The turn timer keeps running while a player is disconnected.
- After `disconnectGraceMs` (default 60 s) a bot takes over the seat and `BOT_TOOK_OVER` is broadcast.
- A returning player authenticates, receives a `GET_VIEW` snapshot and takes the seat back at the next turn boundary.
- If every human seat has been disconnected for `abandonAfterMs` (default 10 min), the match ends as `ABANDONED` with no winner. Leaving penalties for ranked play are outside this specification.

### 19.3 Server restarts

The match actor rebuilds state from the last hand-start snapshot plus the events after it (section 22). Stored absolute deadlines are rescheduled. Missed deadlines fire immediately as `TIMEOUT` commands, in order.

### 19.4 Bots

- Bots read only `view(state, seat)` and `LEGAL_ACTIONS`, exactly as a client does. A bot with access to full server state is a defect.
- The timeout policy in 19.1 is the deterministic baseline bot, used in tests. Stronger bots MAY replace it for live play.
- Bot response delay is drawn from a fixed distribution (for example uniform 0.6–1.5 s), independent of the decision.

## 20. Data model

The server holds `MatchState`; clients only ever receive `SeatView`. Types are written in TypeScript but are language-neutral.

```typescript
type Suit = 'C' | 'D' | 'H' | 'S';
type Rank = 'J' | '9' | 'A' | 'T' | 'K' | 'Q' | '8' | '7';
type CardId = `${Rank}${Suit}`;
type Seat = 0 | 1 | 2 | 3;
type Team = 'A' | 'B';

type Phase =
  | 'DEAL_1' | 'REDEAL_WINDOW' | 'AUCTION' | 'TRUMP_SELECTION' | 'DEAL_2'
  | 'SECOND_ROUND' | 'TRUMP_RESELECTION' | 'DOUBLING'
  | 'PLAY' | 'PAIR_WINDOW' | 'SCORING';

interface MatchState {
  matchId: string;
  version: number;                       // +1 per applied command
  ruleset: RulesetConfig;                // frozen copy (section 2)
  tableSettings: TableSettings;          // timers, visibility (sections 17, 19)
  seats: Record<Seat, {
    playerId: string | null;
    isBot: boolean;
    presence: 'online' | 'background' | 'offline';
    partyId: string | null;              // parties always sit as partners (section 23.2)
    timeBankMs: number;                  // remaining for this match (section 19.1)
    prefs: { autoPlayForced: boolean; autoDeclarePair: boolean; allowPreselect: boolean };
    preselected: CardId | null;          // server-held, never sent to other seats
  }>;
  gameScores: Record<Team, number>;
  dealer: Seat;
  handNumber: number;                    // scored hands, from 1
  dealNumber: number;                    // all deals, including voided ones
  hand: HandState | null;
  status: 'IN_PROGRESS' | 'FINISHED' | 'ABANDONED';
  winner: Team | null;
}

interface HandState {
  phase: Phase;
  deck: CardId[];                        // full shuffled order; server only
  hands: Record<Seat, CardId[]>;         // accessible cards only
  concealed: { owner: Seat; card: CardId | null } | null;  // card null until a seventh card is dealt
  auction: AuctionState;
  declarer: Seat | null;
  originalContract: number | null;       // final bid, used for score bands
  effectiveContract: number | null;      // after pair adjustments
  trumpSuit: Suit | null;
  trumpMode: 'card' | 'suit' | 'seventhCard' | null;
  trumpRevealed: boolean;
  reveal: { by: Seat | 'system'; trickIndex: number; position: number } | null;
  stakeMultiplier: 1 | 2 | 4;
  doubling: { doubledBy: Seat | null; redoubledBy: Seat | null };
  currentTrick: { index: number; leader: Seat; plays: { seat: Seat; card: CardId }[] };
  completedTricks: CompletedTrick[];
  capturedPoints: Record<Team, number>;
  pair: { seat: Seat; team: Team } | null;
  toAct: Seat | null;
  deadline: number | null;               // epoch ms
}

interface AuctionState {
  style: 'priorityDuel' | 'openAscending';
  round: 1 | 2;
  current: number | null;
  highBidder: Seat | null;
  holder: Seat | null;                   // priorityDuel only
  nextChallengerIndex: number;           // priorityDuel only
  active: Seat[];
  history: { seat: Seat; action: 'BID' | 'HOLD' | 'PASS'; amount?: number; auto: boolean }[];
}

interface CompletedTrick {
  index: number;                         // 1..8
  leader: Seat;
  plays: { seat: Seat; card: CardId; trumpPower: boolean }[];  // trumpPower fixed at resolution
  winner: Seat;
  points: number;                        // includes last-trick bonus
}

interface SeatView {
  seat: Seat;
  version: number;
  myHand: CardId[];
  handCounts: Record<Seat, number>;
  concealedOwner: Seat | null;
  myConcealedCard?: CardId;              // declarer only, before reveal
  trumpSuit?: Suit;                      // declarer before reveal; everyone after
  legalActions?: LegalAction[];          // actor only
  // plus every public field: dealer, scores, auction history, contract,
  // stake, current trick, visible trick history, reveal, pair, deadline
}
```

## 21. Validation, invariants and error codes

Every command is validated before it changes anything, and every state is checked against the invariants below. In development and test builds, check invariants after every command; in production, check at least after every trick and at hand end. A failure in production voids the deal (section 16) and opens an incident.

### 21.1 Invariants

1. Each of the 32 card IDs is in exactly one location: undealt deck, a hand, the concealed slot, the current trick or a completed trick.
2. After the phase-1 deal each seat holds 4 cards; after phase 2, 8 (counting the concealed card), minus cards already played.
3. Each completed trick has exactly four plays, one from each seat, in `next()` order from its leader.
4. Captured card points plus points still in play equal 28 (plus the bonus if trick 8 is done and the bonus is on).
5. At hand end: 8 completed tricks, all 32 cards played, the concealed slot empty, and `declaringPoints + defendingPoints = totalPoints`.
6. `trumpRevealed` implies `trumpSuit` and `reveal` are set and the concealed card is back in hand or played.
7. `effectiveContract` stays between `pair.floor` and `pair.ceiling` (or equals `originalContract` when pair is off).
8. Each scored hand produces exactly one `HAND_SCORED` and changes only the declaring team's score.
9. The dealer changes only after `HAND_SCORED`, or after `DEAL_VOIDED` under `redealDealer = rotate`.
10. `version` strictly increases; per-recipient `seq` has no gaps.
11. No `SeatView` contains another seat's cards or a trump suit the seat is not entitled to (asserted in tests by diffing views against entitlements).

### 21.2 Error codes

A rejection returns `{ commandId, ok: false, code, message, version }` to the sender only. `message` is generic and localizable and never names hidden cards.

| Code | Meaning |
| --- | --- |
| `UNAUTHORIZED` | Session is not seated at this match |
| `MATCH_OVER` | Match is finished or abandoned |
| `WRONG_PHASE` | Command is not valid in the current phase |
| `NOT_YOUR_TURN` | Another seat is to act |
| `TURN_EXPIRED` | Arrived after the deadline |
| `STALE_STATE` | `expectedVersion` is behind; a fresh snapshot is attached |
| `RATE_LIMITED` | Too many commands |
| `BID_INVALID` | Not an integer, or outside `minBid`–`maxBid` |
| `BID_TOO_LOW` | Does not exceed the current bid (or the second-round minimum) |
| `HOLD_NOT_ALLOWED` | Sender is not the holder, or style is not `priorityDuel` |
| `PARTNER_OVERBID_TOO_LOW` | Bid over a partner below `partnerOverbidMin` |
| `TRUMP_SELECTION_INVALID` | Card not in hand, suit not allowed, or seventh card disabled |
| `CARD_NOT_IN_HAND` | Card is not in the sender's accessible hand |
| `MUST_FOLLOW_SUIT` | Sender holds the led suit |
| `MUST_PLAY_TRUMP` | Caller holds trump and `callerMustTrump` is on |
| `MUST_PLAY_INDICATOR` | Declarer must play the returned concealed card |
| `CANNOT_LEAD_HIDDEN_TRUMP` | Declarer led trump before the reveal while holding other suits |
| `REVEAL_NOT_ALLOWED` | Sender can follow suit, trump is already public, or reveal must come first |
| `DOUBLE_NOT_ALLOWED` | Doubling is off, or sender is not the one to act |
| `PAIR_NOT_ELIGIBLE` | Any condition in section 13.1 fails |
| `REDEAL_NOT_ELIGIBLE` | Option is off, or the sender's first four cards hold points |

A repeated `commandId` is not an error: the server returns the original response.

## 22. Randomness, persistence, replay and audit

Every deal comes from a cryptographically secure shuffle, every event is stored before anyone sees it, and any match can be replayed exactly from its log.

**Randomness.** Production shuffles use the platform CSPRNG (section 6). Store the resulting deck order, not a seed: a leaked seed would expose every hand dealt from it. Tests inject a seeded PRNG through the same interface; that PRNG MUST NOT be reachable in production builds.

**Provable fairness (optional).** Before the phase-1 deal, publish `commitment = SHA-256(deckOrder ‖ salt)` with a fresh 32-byte random salt. After `HAND_SCORED`, publish `deckOrder` and `salt` so any client can check the deal was fixed before bidding began.

**Persistence**

- Keep one append-only log per match of accepted commands and emitted events.
- Write a snapshot at the start of every hand, including the deck order encrypted at rest with a key held in a KMS.
- Persist each event before broadcasting it, so no client ever sees an event that could be lost.
- One writer per match (section 18) means no write conflicts.

**Replay.** Given the ruleset copy, the engine version, the deck order of every deal and the accepted commands, `apply` MUST reproduce identical events (timestamps excepted). CI SHOULD replay a corpus of recorded matches on every engine change and compare event hashes.

**Versioning.** Each match stores the engine version it started on and is replayed with that version. Migrations never rewrite stored history.

**Audit and disputes.** After a match ends, staff tooling can show every deal, command, timestamp and hidden card. Keep logs for at least 90 days for casual play and longer for ranked play or open disputes. Use pseudonymous player IDs in logs.

## 23. Online play: lobby, matchmaking and tables

Players reach a table by private invite, quick match or ranked match. A match starts only when all four seats are filled and every human has confirmed they are ready.

### 23.1 Ways to start a match

| Mode | How seats fill | Bots | Ruleset | Counts toward |
| --- | --- | --- | --- | --- |
| Private table | Host shares a 6-character code or link, picks seats and ruleset | Host may put a bot in any empty seat | Any preset | Casual history |
| Quick match | Matchmaker by region and preset; parties stay together | After `botFillAfterSec` (default 45 s) of waiting, empty seats get bots | Presets the server offers | Casual history |
| Ranked | Matchmaker by rating, region and preset | Never at the start; a bot only replaces a disconnected player (section 19.2) | `29-standard` | Rating |

### 23.2 Seating, parties and readiness

- A party of two always sits as partners and never on opposite teams. Two friends as opponents could share each other's cards outside the game.
- Quick and ranked match accept parties of one or two. Four friends use a private table.
- The matchmaker places a table on the server region with the lowest worst-case latency for its four players. Target: 95th-percentile command round-trip under 300 ms.
- When four seats are filled, each human has 15 s to tap Ready. A no-show is removed: in quick or ranked match the others go back to the front of the queue; at a private table the seat reopens.
- Seats are shown relative to the viewer: you at the bottom, your partner at the top, opponents left and right (section 24.1).

### 23.3 Chat

- **During a hand:** quick-chat phrases and emotes only, chosen from a fixed list that cannot describe cards (for example "Good luck", "Well played", "Oops", "Thanks"). No free text and no in-game voice: a typed "I have the jack" would break the game, just as it is forbidden at a real table.
- **Between hands and after the match:** free text MAY be offered, with a profanity filter.
- Any player can mute or report any other. Chat is rate-limited to one message per 2 seconds.
- Partners on an outside voice call cannot be stopped technically. Ranked play relies on the collusion analytics noted in section 17.

### 23.4 Leaving, rematch and history

- A player who taps Leave mid-match is replaced by a bot at once, with no grace period. In ranked play the match counts as a loss for them; any further leaver penalty is product policy.
- After `MATCH_ENDED`, everyone gets a Rematch prompt. If all four humans accept within 20 s, a new match starts with the same seats and a new random first dealer.
- Each player can review their recent matches, including every hand summary.

### 23.5 Lobby commands and events

| Command | Payload | Effect |
| --- | --- | --- |
| `CREATE_TABLE` | Preset, table settings | Returns a join code and link |
| `JOIN_TABLE` | Code | Joins as an unseated guest |
| `TAKE_SEAT` / `ADD_BOT` | Seat | Fills a seat (bots: host only) |
| `QUEUE` / `CANCEL_QUEUE` | Mode, preset, party ID | Enters or leaves matchmaking |
| `READY` | none | Confirms the ready check |
| `LEAVE_TABLE` | none | Leaves the table or match |
| `REMATCH_VOTE` | Yes or no | Votes after the match ends |

Lobby events: `TABLE_UPDATED`, `MATCH_FOUND`, `READY_CHECK`, `READY_FAILED`, then `MATCH_STARTED` (section 18.4).

## 24. Mobile client requirements

The phone app is a thin, touch-first view of server state: every rule lives on the server, and the client's job is clarity, speed and surviving bad networks.

### 24.1 Table layout (portrait)

- Portrait is the primary orientation; landscape is optional on tablets.
- You sit at the bottom and your partner at the top. `next(you)` sits on your right when play is counterclockwise (left when clockwise), so turn order visibly moves around the table.
- Always on screen: both teams' game scores, the contract and declarer, the stake, whose turn it is with a countdown ring, and trump status (a face-down card on the declarer's avatar until revealed, then the suit badge).
- Only the declarer sees their concealed card and the trump suit, labelled "Only you can see this".
- Tapping the trick pile shows the previous trick, within `trickHistoryVisibility`.

&#91;embedded content: phone table layout · portrait, counterclockwise play\]

The raised card in the hand is the one tapped once; the coloured ring follows whoever is to act.

### 24.2 Touch input

- Cards fan along the bottom. Legal cards show in full colour; illegal cards are dimmed.
- Playing is two-step by default: tap to raise a card, tap again or swipe up to play. A setting allows one-tap play.
- Tapping an illegal card shakes it and shows one short reason, such as "Follow hearts".
- Touch targets are at least 44 × 44 pt (iOS) or 48 × 48 dp (Android). On a 360 dp-wide screen, eight overlapping cards each keep an exposed strip of at least 40 dp, and the raised card enlarges.
- Bidding shows only the legal values, plus Pass, plus Hold when you are the holder, with the current bid and holder above them.
- Call trump or Reveal trump appears as a separate button only when it is legal for you.
- A light haptic tick marks your turn; a stronger one marks 5 s remaining.

### 24.3 Automation settings

These per-player settings are stored on the server, so they keep working while the app is in the background.

| Setting | Default | Behaviour | Why it leaks nothing |
| --- | --- | --- | --- |
| `autoPlayForced` | On | When exactly one card is legal, the server plays it | Played after a random 0.6–1.5 s delay, the same as bots, so speed never reveals a singleton |
| `autoDeclarePair` | On | The server declares an eligible pair when the trick completes | Declarations are public; see section 13.2 for when a window is still needed |
| `preselectCard` | Off | Choose a card before your turn; it is played on your turn if still legal, otherwise dropped | Held on the server; played after the same random delay |
| `sortHand` | By suit, then rank | Display only | Never sent to other seats |

### 24.4 App lifecycle and connectivity

- **Backgrounding.** Phones usually close the socket within seconds of the app leaving the foreground. The client sends `PRESENCE background` if it can; either way the server treats the seat as disconnected (section 19.2) and the turn timer keeps running.
- **Return.** The client reconnects and sends `RESUME` with its last `seq`. The server replays missed events from its per-seat buffer (the current hand) or, if they are gone, sends a snapshot. Target: back in sync within 1 s on 4G.
- **Reconnect backoff.** Retry after 0.5, 1, 2 and 4 s, then every 8 s, each with ±20% jitter. Retry at once when the OS reports a network change.
- **Timers.** Countdowns use `remainingMs` from the `TURN` event, measured on the device's monotonic clock. The device wall clock is never trusted.
- **Optimistic animation.** The client may animate a played card immediately but must snap it back if the server rejects it.
- **Push notifications** (app in background only): "Match found", "A bot is playing for you, tap to return" and "Your rematch is starting". They go only to the affected player and never mention cards.
- **Versions.** The client sends `protocolVersion` in `HELLO`. The server supports the current and previous versions and answers anything older with `UPGRADE_REQUIRED`.
- **Data use.** Events are small JSON (or MessagePack) over a compressed WebSocket. A full snapshot SHOULD stay under 8 KB. Heartbeats run every 10 s during a match and every 25 s in the lobby.

### 24.5 Accessibility and localisation

- Every card has a spoken label for VoiceOver and TalkBack ("Jack of spades", plus "trump" once public). Turns and trick winners are announced.
- Suits always show a symbol and a letter, never colour alone. A four-colour deck is optional.
- Menus respect system font scaling up to 200%; animations respect Reduce Motion.
- UI text and quick-chat phrases are translated into the launch market's languages (for example Bangla, Hindi, Nepali or Malayalam).

### 24.6 Performance targets

| Measure | Target |
| --- | --- |
| Cold start to lobby, mid-range Android phone from the launch market | Under 3 s |
| Animation frame rate | 60 fps |
| Card-play animation | 300 ms or less, never delaying the next turn |
| Network tolerance | 400 ms round-trip and 2% packet loss with no desync |
| Background polling | None; one WebSocket only |

## 25. Acceptance tests

A release is ready when all 64 scenario tests below pass for every shipped preset and the property tests run clean. Unless a row says otherwise, tests use `29-standard` and a seeded test deck.

| ID | Area | Scenario | Expected |
| --- | --- | --- | --- |
| T01 | Deck | One suit played in a trick | J > 9 > A > 10 > K > Q > 8 > 7 |
| T02 | Deck | Build the deck; total points, bonus off and on | 32 unique IDs; 28; 29 |
| T03 | Seats | `next()` from seat 0 | Counterclockwise 3, 2, 1, 0; clockwise 1, 2, 3, 0 |
| T04 | Seats | Declarer is not eldest | Eldest still receives first, bids first, leads trick 1 |
| T05 | Deal | Capture all traffic before phase 2 | No phase-2 card appears in any client message |
| T06 | Deal | 1,000,000 shuffles, card × position counts | Chi-square uniformity passes at p > 0.001 |
| T07 | Duel | Challenger bids equal to current | `BID_TOO_LOW`; holder's equal bid is accepted as a hold |
| T08 | Duel | Section 7.2 example | P2 declarer at 19 |
| T09 | Duel | Holder holds 28 | Later challengers auto-passed; auction ends without prompts |
| T10 | Duel | Forced opener passes, or bids 15 | Rejected: `WRONG_PHASE` / `BID_INVALID` |
| T11 | Auction | Passed player tries to bid | Rejected; state unchanged |
| T12 | Ascending | Three players pass after a bid | Auction ends; high bidder is declarer |
| T13 | 28 | Bid 19 over partner's 16; then 20 | `PARTNER_OVERBID_TOO_LOW`; 20 accepted |
| T14 | 28 | Second round, all pass | Contract and trump unchanged |
| T15 | 28 | Opponent bids 24 in second round | New declarer; old concealed card silently back in old declarer's hand; new card concealed |
| T16 | 28 | Second-round bid of 23 | `BID_TOO_LOW` |
| T17 | Trump | Declarer conceals a card | Card leaves hand; partner's view has no trump field |
| T18 | Trump | `external`, declarer picks a suit they lack | Accepted |
| T19 | Trump | Declarer's only led-suit card is concealed | Declarer counts as void and may discard |
| T20 | Double | Double, then redouble | Stake 2, then 4; no further doubling prompts |
| T21 | Double | Redoubled contract fails | Declaring team −4; card points unchanged |
| T22 | Play | Holding led suit, play another suit | `MUST_FOLLOW_SUIT` |
| T23 | Play | Declarer leads trump pre-reveal holding other suits; then holding only trumps | `CANNOT_LEAD_HIDDEN_TRUMP`; must reveal, then may lead any trump |
| T24 | Reveal | Void player discards without calling | Accepted; trump stays hidden |
| T25 | Reveal | Caller holds trump and plays a non-trump; caller with no trump | `MUST_PLAY_TRUMP`; any card accepted |
| T26 | Reveal | `29-simplified`: void player plays before revealing | Rejected; only CALL\_TRUMP or REVEAL\_TRUMP is legal |
| T27 | Reveal | `28-standard`: declarer reveals, plays another trump | `MUST_PLAY_INDICATOR` |
| T28 | Reveal | Void player after the reveal plays a non-trump | Accepted |
| T29 | Reveal | Player who can follow suit calls for trump | `REVEAL_NOT_ALLOWED` |
| T30 | Resolve | Off-suit jack against a led-suit seven, no trump power | Seven wins |
| T31 | Resolve | Section 12 examples 1–4; example 1 under `wholeTrick` | Winners as stated; P2 under `wholeTrick` |
| T32 | Resolve | Reveal after a trick containing a trump-suit discard | Earlier trick's winner unchanged |
| T33 | Resolve | Trump still hidden at trick 8 | Auto-reveal before lead; concealed card played in trick 8 |
| T34 | Resolve | `external`, never revealed | All tricks by led suit; trump disclosed in summary |
| T35 | Pair | Hands with and without a pair holder | Identical window timing after every post-reveal trick 1–7 |
| T36 | Pair | Declaring pair at contract 20; at contract 16 | Target 16; stays 16 |
| T37 | Pair | Defenders' pair at contract 26 | Target 28 |
| T38 | Pair | Team lost the trick; or K already played | `PAIR_NOT_ELIGIBLE` |
| T39 | Score | Declaring team captures exactly the contract | Success |
| T40 | Score | Contract made; contract failed | Defenders' score unchanged both times |
| T41 | Score | `lastTrickBonus` off, then on | Totals 28, then 29; bonus to trick 8 winner only |
| T42 | Score | Bands keyed on bid, pair changes the target | Band chosen by `originalContract` |
| T43 | Match | Score +3, redoubled success (+4) | Match ends at +7 |
| T44 | Match | Scored hand; voided deal | Dealer moves by `next()`; same dealer after void |
| T45 | Server | Same `commandId` sent twice | Applied once; same response twice |
| T46 | Server | Old `expectedVersion` | `STALE_STATE` with fresh snapshot |
| T47 | Server | Each decision times out | Defaults from section 19.1 |
| T48 | Server | Disconnect past grace, then reconnect | Bot takes over; player reclaims at next turn; snapshot equals filtered view |
| T49 | Server | Kill the server mid-trick | Restart resumes identical state and deadlines |
| T50 | Server | Replay 1,000 recorded matches | Identical event streams (timestamps excepted) |

**Mobile and online tests**

| ID | Area | Scenario | Expected |
| --- | --- | --- | --- |
| T51 | Mobile | App backgrounded 10 s mid-hand, then resumed | `RESUME` replays missed events; view matches server |
| T52 | Mobile | Device clock set 5 minutes wrong | Countdown matches the server deadline within 500 ms |
| T53 | Mobile | Turn timer expires with 30 s left in the time bank | Bank used and updated `TURN` sent; timeout default only after the bank is empty |
| T54 | Mobile | Single legal card with `autoPlayForced` on | Played after 0.6–1.5 s; delay distribution independent of the hand (statistical test) |
| T55 | Mobile | All seats have `autoDeclarePair` on; eligible pair | Declared at trick completion; no pause |
| T56 | Mobile | One seat opts out of `autoDeclarePair` | Windows open after that team's post-reveal tricks whatever the cards |
| T57 | Mobile | Preselected card is illegal when the turn arrives | Dropped; player prompted normally |
| T58 | Mobile | Client two protocol versions behind | `UPGRADE_REQUIRED` |
| T59 | Online | Party of two in quick match | Always seated as partners |
| T60 | Online | Free-text chat during a hand | Rejected; quick-chat accepted |
| T61 | Online | Quick match waits 45 s with three humans | One bot fills the seat; ranked never starts with bots |
| T62 | Online | Player taps Leave mid-match | Bot takes the seat at once; ranked records a loss |
| T63 | Network | 1,000 simulated matches at 400 ms round-trip and 2% loss | All complete with no desync |
| T64 | Accessibility | Screen reader on the hand | Every card announced by name; touch targets at least 44 pt / 48 dp |

**Property tests.** For each preset, simulate at least 100,000 hands with random legal actions and random timeouts, and assert after every command:

- all invariants in section 21.1 hold;
- the player to act always has at least one legal action;
- no `SeatView` contains information beyond its entitlement;
- every hand ends with 8 tricks, 32 cards played and one score update.

## 26. Corrections to the original specification

Eighteen issues in the original draft are fixed here. The draft's behaviour survives as the `29-simplified` preset wherever it was a legitimate simplification rather than an error.

| # | Original draft | Problem | Fix |
| --- | --- | --- | --- |
| 1 | Clockwise play | Twenty-Nine is usually played counterclockwise; the comparison table presented direction as a 29/28 difference | Counterclockwise default; `direction` configurable (section 4) |
| 2 | Deal "starting clockwise from dealer" | Could be read as dealing to the dealer first | Dealing starts with `eldest = next(dealer)` (section 6) |
| 3 | Open ascending auction | Standard Twenty-Nine uses priority duels where the earlier player may hold | `priorityDuel` default (section 7.2) |
| 4 | A maximum bid ends the auction at once | Under priority rules a holder may still hold the maximum | Auto-pass any player with no legal bid (section 7.1) |
| 5 | External indicator; any suit allowed | Standard play marks trump with a card from the declarer's four, so the suit must be held | `faceDownCard` default (section 8) |
| 6 | Mandatory reveal; revealer need not trump | Common rule: calling is optional, and a caller must trump if able | `optionalOnVoid` with `callerMustTrump` (section 11) |
| 7 | Declarer may lead hidden trump | Commonly forbidden while holding other suits | Lead restriction with an only-trumps exception (section 10.2) |
| 8 | Whole reveal trick uses trump | No effect under mandatory reveal; gives retroactive power under optional reveal; undefined when trump is led | `fromRevealPosition` plus the led-trump rule (section 12) |
| 9 | Voided-hand policy required, no void conditions given | Nothing could void a hand | Triggers, procedure and dealer policy (section 16) |
| 10 | Pair timing left open | Not implementable; a naive pause leaks who holds the pair | Eligibility, fixed window, floor and ceiling (section 13) |
| 11 | Double before the second deal | Defenders decide on four cards | `afterFullDeal` default; old timing kept as an option (section 9) |
| 12 | 28: only declarer or partner may raise; trump never changes | Standard second round is open to all players, and a new declarer chooses trump | Open second round with reselection (sections 7.4, 8.4) |
| 13 | 28: raising partner "after the left-hand opponent has passed" needs 20 | Not the usual rule | Bidding over a partner needs 20 or more (section 7.3) |
| 14 | 28: three scoring bands | The 25–28 band is not well attested | Two bands by default, fully configurable (section 14) |
| 15 | 28: match thresholds "must be configured" | No default, so the engine cannot run | ±6 house default, configurable (section 2) |
| 16 | 28: concealed card "must become available" by the end | Not an algorithm | Automatic reveal at the start of trick 8 (section 11.5) |
| 17 | Score input unspecified when a pair changes the target | Ambiguous band lookup | Bands use `originalContract` (section 14) |
| 18 | No production requirements | No timers, reconnects, idempotency, RNG rules, side-channel rules or error codes | Sections 17–22 |

## 27. Variance notes, open decisions and sources

The defaults reflect common Twenty-Nine and Twenty-Eight practice as described on Pagat, written from memory: the source pages were not opened while this spec was drafted. Regional rules differ, so confirm the items below with players from your launch market before release. Each is already a configuration key, so a change needs no engine rework.

- [ ] Forced opening bid in Twenty-Nine, or optional opening with a redeal on four passes (`openingBidForced`, `allPassPolicy`)
- [ ] Minimum bid 16, or 15 at some tables (`minBid`)
- [ ] Pair timing: after any trick the team wins, or only the first one after the reveal (section 13.1)
- [ ] Doubling timing, and whether high bids (21+) raise stakes automatically (`doubling`)
- [ ] Whether a caller must trump, and whether undertrumping is restricted (`callerMustTrump`)
- [ ] Twenty-Eight second-round mechanics, score bands and match target (`secondRound`, `scoreBands`, `matchEnd`)
- [ ] Twenty-Eight declarer reveal play: the returned card, or any trump (`declarerRevealPlay`)
- [ ] Whether to offer the seventh-card option and the pointless-four redeal at launch

**Mobile and online decisions**

- [ ] Turn limits (20 s) and time bank (30 s per match): right for your players' phones and networks? (section 19.1)
- [ ] `autoDeclarePair` and `autoPlayForced` on by default (section 24.3)
- [ ] Free-text chat between hands, or quick-chat only throughout (section 23.3)
- [ ] Launch languages and server regions (sections 23.2, 24.5)
- [ ] Ranked mode at launch, or casual and private tables only (section 23.1)

**Sources** (cited by the original draft; verify the defaults above against them)

- [Pagat: Twenty-Nine](https://www.pagat.com/jass/29.html)
- [Pagat: Twenty-Eight](https://www.pagat.com/jass/28.html)
