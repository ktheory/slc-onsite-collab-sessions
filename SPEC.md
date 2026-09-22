# Breakout board — build spec.

A scheduling tool for arranging breakout sessions at a team on-site. People pick
topics, sessions get assigned to time slots, and nobody ends up in two places at
once.

`prototype.html` is a working single-file version, built as a Claude artifact. It
is the behavior reference, not the starting codebase — read it to see what the
thing does, then build the real version properly.

## What's in this folder.

| File | What it is |
| --- | --- |
| `prototype.html` | The working prototype. Self-contained: no build step, no dependencies. |
| `seed-sessions.json` | The session data currently in the prototype, exported from its store. |
| `SPEC.md` | This file. |

To run the prototype locally, open `prototype.html` in a browser. It will report
that changes aren't being saved, because its storage layer only exists inside the
Claude artifact runtime. Everything else works.

## Fixed data.

The roster and the slot list are hard-coded. Both should become editable data in
the real version, but they're stable enough for the on-site itself.

Twelve people, keyed by the local part of their `@instructure.com` address:

```
aaron.suggs       Aaron Suggs
ahmad             Ahmad
ciara.montes      Ciara Montes
dnehring          Daniel Nehring
emily.stupar      Emily Stupar
jackson.howe      Jackson Howe
jenny.thai        Jenny Thai
kqiu              Kevin
kyle.cayemittes   Kyle Cayemittes
michelle.trame    Michelle Trame
ryan.dontas       Ryan Dontas
terran.jendro     Terran Jendro
```

Five slots:

```
s1   Tuesday    2:15 PM
s2   Wednesday  9:45 AM
s3   Wednesday  2:00 PM
s4   Wednesday  3:30 PM
s5   Thursday   1:00 PM
```

Slots have no duration and no date. If the real version needs calendar invites,
they'll need both.

## Data model.

One entity. A session belongs to exactly one slot and holds a list of people.

```jsonc
{
  "id":        "string",     // opaque, client-generated in the prototype
  "topic":     "string",     // free text, max 120 chars, may be empty
  "slot":      "s1".."s5",   // exactly one
  "people":    ["aaron.suggs", "..."],  // person ids, may be empty
  "example":   false,        // prototype-only: marks a seeded placeholder
  "createdAt": "ISO 8601"    // sort key within a slot
}
```

Drop `example` when you build the real one. It only exists so the prototype could
open in a populated state with a one-click way to clear the placeholders.

A relational schema would be `sessions` plus a `session_attendees` join table, with
a unique constraint on `(person_id, slot_id)` — that constraint is the whole
invariant, see below.

## The one rule that matters.

**A person can be in at most one session per slot.** They can be in several
sessions across different slots, and a slot can hold any number of sessions.

The prototype enforces this in four places. Whatever you build needs all four,
plus a database constraint the UI can't talk its way around:

1. **Adding a person.** The roster in each session card greys out anyone already
   booked in that slot and labels them with the session they're in.
2. **Adding a person, again.** The click handler re-checks before writing, because
   the greyed-out state can be stale if someone else just edited.
3. **Moving a session.** Dragging a session to a new slot, or picking a slot from
   the card menu, removes anyone who's already busy at the destination and says
   who came off. It never silently creates a clash, and never refuses the move.
4. **Detecting a clash anyway.** Two people editing at once can still double-book
   someone, because writes are last-writer-wins with no transaction. The summary
   line calls out anyone in two sessions in one slot so a human can fix it.

Point 4 goes away if you give the real version a transactional write path. Points
one through three are UI affordances and still earn their keep.

## Screens and behaviors.

**By slot** (default). One section per slot, in chronological order. Each section
has an "Add session" button, a grid of session cards, and a line listing who's free
that slot. Each card has a drag handle, the topic as an auto-growing text field, the
attendees as removable chips, an "Add people" toggle that opens the full roster, an
attendee count, a slot menu, and a two-step delete.

**By person.** A twelve-by-five grid, people down the side and slots across the top,
each cell naming the session that person is in. Rows for people with nothing
scheduled are flagged. This is the view that answers "who's got a hole in their day"
and "did we forget anyone", which is the main thing the by-slot view can't show.

**Moving sessions.** Drag by the handle, drop on any slot section. The slot menu on
each card does the same thing for touch and keyboard users — keep both.

**Live updates.** Every viewer sees every change. The prototype subscribes to the
whole session collection and re-renders, which is fine at this size and would not be
at a larger one.

## What the prototype fakes, and what it gets right.

Fakes:

- **Storage.** It calls `window.claude.use("db")`, an artifact-runtime document
  store. Replace it wholesale. The read path is one subscription to a collection;
  the write path is create, field-merge update, and delete by id.
- **Identity.** There is none. Anyone who opens the page can change anything, and
  no change records who made it.
- **Access control.** Handled by artifact sharing, which doesn't transfer.

Gets right, and worth carrying over:

- **Optimistic writes.** Local state updates immediately, the store echoes back and
  corrects. The page stays responsive on a hotel wifi connection, which is the
  network this will actually run on.
- **Degrading to read-only.** If storage is unavailable or the grant is revoked, the
  page keeps working locally and says changes aren't being saved, instead of
  breaking.
- **Focus preservation across re-renders.** Full re-render on every snapshot would
  otherwise eject you from the topic field mid-word whenever a teammate edits.
- **Debounced topic saves.** 550ms, flushed on blur.

## Open decisions.

None of these are settled, and the prototype doesn't imply an answer:

- Who can edit — everyone, or an organizer? The prototype assumes everyone.
- Does this need to survive past this one on-site, or is it disposable?
- Should it write calendar invites? That needs real dates and durations on slots.
- Is a per-person cap on sessions useful, or does the free-this-slot line cover it?
- Should people sign themselves up rather than an organizer placing them?

That last one is the big fork. A sign-up tool and a planning tool look similar and
behave differently — sign-up needs identity, per-person actions, and probably a cap
per session. Worth settling before anyone writes a schema.

## A reasonable first move.

The invariant is the interesting part and the rest is CRUD. Start with the schema
and the `(person_id, slot_id)` unique constraint, get the move-with-bumping behavior
right against it, and put the UI on top of that. The prototype's conflict logic
lives in `togglePerson` and `moveSession` and is short enough to read in one sitting.
