# Assignment 10 — Asset Lending

## The scenario

Picture an organization running a small lending library of shared equipment — cameras, tools,
projectors, whatever people need to borrow rather than buy one of each — tracked on a sign-out sheet
taped to the shelf. Whoever wants something writes their name next to it, and whoever brings it back
is supposed to cross their name off, eventually.

The result is predictable. Two people both think an item is available, and only one of them finds
out otherwise, after it's already checked out to someone else. An item stays checked out for a month
past when it should have come back because nobody is watching the sheet closely enough to notice,
and by the time someone does notice, the borrower has genuinely forgotten they still have it. An
item goes missing and the sheet still shows it as available, so the next person who wants it finds
an empty shelf and no explanation.

They want one system: a librarian keeps the catalogue current, members request and return items
through it, and availability always reflects whether an item actually has an open loan against it.
Anyone should be able to tell what is currently out, and what is overdue, without checking a shelf
by hand. Build the system that replaces the sign-out sheet.

## What it must do

Everything below is required. Several of the ten spell out exact rules — what happens on an illegal
move, what a bulk action must report back, when a dismissed alert is allowed to reappear — and those
specifics are the actual ask, not just the bold headline in front of them.

1. **Accounts and roles.** People sign in with an email and password, and there are at least two
roles — a librarian role and a member role. Librarians create and archive catalogue items, issue and
process the return of loans, mark items lost, and see every loan in the system. Members can request
an item and see their own loans, but cannot issue a loan, process a return, or mark an item lost.
The difference must be enforced on the server, not just hidden in the interface.

2. **Catalogue items.** Librarians create catalogue items with a title, a category, and an
identifying code, and can edit them later. Items can be archived and restored. Archiving removes an
item from the default catalogue view without destroying its loan history.

3. **Loans.** Every loan belongs to exactly one catalogue item and carries the borrower, the
date it was requested, and a due date once it is issued. Members can request an item, creating a
loan for a librarian to act on; librarians can also create a loan directly. Opening an item shows
every loan ever made against it.

4. **A loan lifecycle with rules.** A loan moves through *Requested → Issued → Returned*. There is
no separate action that marks a loan overdue — a loan is simply treated as *Overdue* whenever it is
still Issued past its due date, computed whenever it's viewed rather than stored as a state of its
own. A loan can be marked *Lost* while it is Issued, whether or not it has become overdue. While a
catalogue item has any open loan against it — Requested or Issued, including one that has become
overdue — the server refuses to issue that item on a different loan. Any other move must be rejected
by the server with a message explaining why.

5. **Custodians.** Any number of librarians can be assigned to a catalogue item as its custodians,
responsible for its condition and location, and a librarian can be a custodian for any number of
items. Every librarian can see one list of every item they are a custodian for, in addition to the
full catalogue.

6. **Finding loans.** One list shows loans across the whole catalogue, with a text search over the
item title and borrower, filters for status, item and borrower, sorting by due date, requested date
or status, and pagination showing the total number of matches. All of this must happen on the server
— do not load every loan into the browser and filter there.

7. **Acting on many items and loans at once.** Librarians can bulk-import catalogue items from a CSV
file; the result is a per-row report naming exactly which rows failed and why, while every valid row
is still imported. Librarians can also select several issued loans and process their return in one
action, and the result reports per loan what succeeded and what was rejected, such as a loan that
was already returned. Separately, export every item currently out on loan, with its borrower and due
date, as a CSV file.

8. **A dashboard.** A landing view shows headline numbers — items currently out, items overdue,
loans returned this week, and total catalogue items. It also breaks loans down by status and by
custodian, and charts items returned per week over the last eight weeks.

9. **History you cannot rewrite.** Every loan has a timeline showing when it was requested, issued,
returned or marked lost, each with who made the change and when, along with any notes left by a
librarian. Nothing in this timeline can be edited or deleted after the fact, including by
librarians.

10. **Overdue loan alerts.** A loan that is Issued and past its due date appears in an alerts area,
with a count badge visible in the navigation. A librarian can dismiss the alert for that loan. If
the item is later issued again and becomes overdue on the new loan, the alert returns.

## Stretch ideas (optional)

None of these are required, and none substitute for a goal above. If you finish all ten with time
left over, pick whichever of these sounds most useful and build it:

- A hold or reservation queue for items that are currently out.
- Late fees or replacement charges for overdue or lost items.
- Multiple copies of the same catalogue title.
- Barcode or QR-code scanning for check-out and check-in.
- Per-member borrowing limits.
- Email reminders before a loan's due date.
- Item condition notes at check-out and check-in.
- A report of the most-borrowed items.
- Renewal requests that extend a due date.


---

## What we are assessing

A working application is table stakes. Almost every serious candidate will produce something that runs, has a login, and roughly does what was asked. That's the floor, not the differentiator.

What actually separates submissions is the record of thinking behind the app: the decisions you made and why, the trade-offs you weighed, what you built first and what you deliberately left out, and whether you can explain any part of your own system when asked. We are hiring for judgement. The app is the evidence for that judgement, not the deliverable in itself.

We also read the code itself for structure and readability, which counts for a small share of the overall score.

## Time budget

Budget about 12 hours total, spent roughly 2 hours a day across a week.

This is not a race. We are not timing you against other candidates, and submitting early scores nothing extra. Twelve hours is a size guide so you know how much to attempt — pace yourself, stop when you're tired, and spend some of that time thinking and documenting, not only typing code.

## Pick any stack you like

Use any language, any framework, any UI library, any ORM, and any database access approach you want. We have no house stack, and no stack scores better than another — this round is not a test of whether you know particular tools.

Use whatever you are fastest and most confident in. Time spent learning something new to impress us is time not spent on the ten goals above, and it will show.

## Using AI is allowed and encouraged

Use AI tools however you want — to scaffold code, debug a stuck problem, write tests, draft documentation, or anything else that helps you move faster. A few things to know about how we treat it:

- We do not penalise AI use, and we make no attempt to detect it.
- We care about whether you understood, directed and verified the output — not about who or what produced the first draft of it.
- `docs/ai-prompts.md` must contain the prompts you actually used, including the ones that produced bad output and what you changed afterwards. If you used no AI at all, say so here and describe how you worked instead — that is assessed the same way.
- Submitting generated code you cannot explain is the single most common way candidates fail this round.

You are accountable for everything in your submission. If a reviewer points at a piece of code and asks why it's there, or why it works the way it does, "the AI wrote it" is not an answer.

## Use git properly

Publish to a public GitHub repository, and commit incrementally as the work actually happens — after each meaningful step, not in one pass at the end.

A repository whose entire history is a single "initial commit" containing a finished app scores zero on git history, and it colours how we read everything else in your submission, however good the app itself is. Your history is how we see the order you built in, where you got stuck, and how the design changed along the way. If it isn't there, we can't assess it, and we won't assume the best.

## What you must commit

Alongside your code, commit these five files under `docs/`. Your zip includes a stub for each with the questions it needs to answer — fill them in as you go, not from memory at the end.

| File | What it must answer |
|------|----------------------|
| `docs/architecture.md` | What the moving pieces are, how they talk to each other, where each one runs, the request path for one representative user action end to end, and what you decided not to build. |
| `docs/schema.md` | Every table's columns and types, which relationships are one-to-many versus many-to-many, which constraints live in the database versus the application, what you deliberately denormalised, and what would break first at 100x the data. |
| `docs/plan.md` | How you split the work into sessions, what order you built in and why, what you estimated versus what it actually took, and what you cut when you ran short. |
| `docs/decisions.md` | At least five real decisions — what you chose, what you rejected, and why — including at least one you later reversed. |
| `docs/ai-prompts.md` | The prompts you actually used, in order, grouped by what you were trying to do, including at least one that produced something wrong and what you did about it. |

## Host it for free

Deploy the whole thing somewhere reachable by URL, using free tiers only.

One combination that works, if you would rather not decide:

- **Database** — a managed service such as Supabase.
- **Server-side code** — Render.
- **Browser-side code** — Vercel.

Deploy in that order: create the database first, give the server its connection details as environment variables, then point the browser-side part at the server's public URL.

This is one option, not a requirement. Any free host is equally acceptable — everything on a single provider, one virtual machine, a container platform, a static host with serverless functions. The choice earns and loses nothing.

Requirements:

- A working live URL.
- Seeded with enough demo data to show the system doing something, not an empty shell.
- Demo credentials for every role recorded in `SUBMISSION.md`.
- Connection strings, keys and passwords kept in environment variables, never in the repository.
- Free tiers often sleep when idle and can take a minute or more to wake. Note it in `SUBMISSION.md` if yours does, so a slow first load is not read as a broken deployment.
- If you cannot get it hosted, submit anyway and record in `SUBMISSION.md` what you tried and where it broke.

## How to submit

Send us:

- The URL of your public GitHub repository.
- The URL of your live, deployed application.
- Your completed `SUBMISSION.md`, committed to the repository.

That's the whole submission. Nothing else to prepare, no separate form.

## What happens next

If your submission clears the bar, we'll set up a short call. We will ask about specific decisions we can see in your repository and its history — why you modelled something a particular way, what a certain commit was fixing, what you'd change if you kept going.

We're telling you this now because it should change how carefully you document as you go. Write `docs/decisions.md` for a version of yourself who has to explain it three weeks from now.

## Scope

The 10 goals stated in this brief are the cutoff. Meet all 10, solidly, and you have a complete submission.

Stretch ideas are optional. They exist for candidates who finish the 10 with time left and want to keep building — they are never required, and they do not make up for a goal you didn't hit. Doing 8 goals well beats doing 10 goals badly. If time is short, finish fewer goals properly rather than leaving all ten half-done.
