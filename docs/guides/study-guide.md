# Study guide

Tokori is opinionated about how you learn a language. The app's
features — vocabulary, reader, tutor, journal, flashcards — are not a
toolbox you assemble at random. They're four pillars meant to be used
together, weighted differently as you progress. This page is the
single source of truth for those principles. The Learning Journey
tab, the AI coach, and the dashboard widgets all reference what's
written here.

## The four pillars

Every productive study session belongs to one of these. The mix
changes as you progress, but the categories don't.

### 1. Review (SRS)

Spaced-repetition flashcard sessions. Words you've saved from
chat, the reader, or imports get scheduled by FSRS-5 and shown back
to you at the moment they're about to be forgotten. This is the
floor of your vocab — without it, words you "knew" yesterday quietly
slip away.

- In-app surface: **Flashcards** tab (Vocab Recall, Sentence Mining,
  Anki Classic, KaniWani).
- Recommended cadence: every day you study. Even five minutes
  clears that day's due queue at small word counts.

### 2. Input (immersion + reading)

Reading and listening to native target-language content with the
intent to understand. The reader, the library (textbooks, articles,
imported books), podcasts, video — anything where you're consuming
real language. Click-to-define lets you turn unknown words into
vocab without breaking flow.

- In-app surface: **Reader**, **Library**, **Click-to-define**
  popover in chat.
- Off-app: anything you log via the Activity timer (podcast, video,
  conversation).

### 3. Tutor (guided practice)

Active back-and-forth with the AI tutor. The chat tab brings every
configured provider to a single interface; the click-to-define
popover and the per-card "Ask AI" surface bring the tutor inside the
flashcard loop. The tutor knows your vocab, your level, and your
recent reading, so its replies stretch you at the right edge of your
ability.

- In-app surface: **Conversation** tab, the per-card **Ask AI**
  drawer, the click-to-define popover.

### 4. Output (production)

Writing or speaking in the target language. Journal entries
get sentence-by-sentence correction. Voice mode (where available)
gets the tutor speaking back at you. Production is the slowest
pillar to ramp up but the one that turns recognition into recall.

- In-app surface: **Journal** tab (writing), **Voice** mode in
  chat (speaking).

## The level score

Tokori derives your current level from a single number:

```
score = vocab_known + 1.5 × min(immersion_hours, 1500)
```

Where:
- `vocab_known` is the count of cards at status `mastered` (the FSRS
  scheduler has decided they're learned).
- `immersion_hours` is the total time logged across every kind of
  study session (review, reader, tutor chat, journal, off-app
  activities).
- The hour multiplier (`1.5`) reflects that an hour of varied
  immersion is worth roughly 1.5 words of "passive" knowledge — a
  smoothing factor borrowed from the Refold model.
- The cap at 1500 hours is a sanity bound: at that point your level
  is dominated by your real vocabulary, not by clocked time.

In plain language: **vocab is your floor; immersion is what makes
that vocab stick**. A learner with 2,000 known words and 100 hours
of immersion is a more rounded HSK 3 than one with 2,000 words and
zero immersion — the latter knows definitions but hasn't seen the
words in real prose.

## The recommended mix

The four pillars aren't equal at every stage. Roughly:

| Phase                     | Review | Input | Tutor | Output |
|---------------------------|--------|-------|-------|--------|
| Early (HSK 1-2 / N5-N4 / A1) | 60%    | 30%   | 10%   | 0%     |
| Building (HSK 3 / N3 / A2-B1) | 35%    | 45%   | 15%   | 5%     |
| Consolidating (HSK 4-5 / N2 / B2) | 20%    | 50%   | 20%   | 10%    |
| Fluency (HSK 6+ / N1 / C1-C2) | 10%    | 55%   | 20%   | 15%    |

These are percentages of *study time*, not of activity count. The
Learning Journey's AI coach uses this matrix to spot imbalance —
if you've spent five hours this week on review and zero on input at
HSK 3, expect a nudge.

The mix is a starting point, not a prescription. Heritage learners
ramp output earlier; exam-focused learners stay heavy on review
longer; learners aiming for travel proficiency lean tutor +
listening. **Override freely**, set your own goals in the Goals
panel, mark milestones complete manually.

## Habits, goals, milestones — three motivational shapes

These overlap, but they hit different cognitive surfaces:

- **Habit** (daily / weekly minutes) — keeps the streak alive.
  Optimised for "show up consistently". Wires into the dashboard's
  streak chip and the consistency heatmap.
- **Goal** (vocab count / minutes / sessions by a deadline) —
  optimised for "ship a concrete result by date X". Wires into the
  pace indicator (ahead / on / behind).
- **Milestone** (a target level on your scale) — optimised for "I am
  somewhere on a longer journey". Surfaced as the Journey tab's
  ladder.

Use one, two, or all three. The dashboard surfaces each separately
so they don't crowd each other.

## Manual override is sacred

Tokori suggests; the user decides. Every recommendation in this
guide — the activity mix, the level ladder, the AI coach's nudges,
the suggested habits — can be overridden. If you study with a
private tutor and don't need flashcards, hide the Flashcards tab.
If your goal is HSK 4 in eighteen months and the journey says
that's unrealistic, change the date and override the milestone.
The app's job is to surface the most likely next step; your job is
to know if that step is actually right for you.

## Where each pillar lives

| Pillar | Surface | Notes |
|--------|---------|-------|
| Review | Flashcards tab | FSRS-5 scheduler. Run daily. |
| Input  | Reader, Library, podcast/video logs | Click-to-define everywhere. |
| Tutor  | Chat, Ask-AI drawer, click-to-define popover | Provider-agnostic. |
| Output | Journal, Voice mode | Journal gives sentence-by-sentence corrections. |
| All four | Activity timer | Logs every kind so the mix is measurable. |

The Learning Journey tab knits all of this together: where you are
on your scale, how the four pillars stack against the recommended
mix, what the coach suggests doing next, which habits would lock in
the pace you want.
