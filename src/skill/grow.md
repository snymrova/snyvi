<!-- snyvi init-claude wrote this; snyvi uninstall-claude takes it out, and an update rewrites it. -->

# After it ships: telling people, by channel

Read `SKILL.md` and [launch.md](launch.md) first. Use this when the user
wants to launch, post, announce, get users or grow what they built, and
before you draft any post: Show HN, Reddit, X or Bluesky, a blog post, a
release note, a listing.

You never post. You draft, as a document (`send_document`), and the user
sends it from their own account. Nothing in snyvi posts on an agent's word.

## First: three lines of position

Every draft reads from these. Write them from the README, the code and the
desk's notes, and ask the user for what you cannot find. Don't invent users,
numbers or quotes.

1. **What it is**, in the words a searcher types ("a CLI that finds stale
   Markdown notes"), not a slogan.
2. **For whom**: one kind of person, by what they do.
3. **Instead of what**: what they use today (a script, a SaaS, a habit).
   The difference is the post.

Say them in the draft's head, so the user can correct them once for all the
posts.

## The channels, in order

Pick the two or three that fit the project; never all of them at once.

| Channel | When | The rule |
|---|---|---|
| The release note | with the release | What changed and how to get it, for people who already use it. Plain, short, first. |
| Show HN | a weekday, 12:00-17:00 UTC | Something people can try now. Title `Show HN: <name> – <what it does>`, at most 80 characters, plain and technical: no "revolutionary", "game-changing", "AI-powered", no emoji, no exclamation mark. The text is first person, written by the maker, and says why they made it, how it works and what it does not do. The maker replies in the thread for the first six hours. A second try, months later, with a real change, is fine. |
| Reddit | the subreddit's own day, if it has one | The one subreddit where its users already are, not ten. Read its rules first; most ask the maker to say they made it, and some want AI involvement said in a weekly thread. Lead with the problem, not the link. |
| X, Bluesky | the day it ships | One post replying to the ship (the release, the merged PR, the demo), with one picture or a short clip. Not a thread of pitches. |
| The blog | within a week | The story: what was hard, what you learned, the numbers. It is what the other posts link to. |
| Listings | any week | Alternatives and "best X" lists, awesome-lists, directories for the ecosystem. A comparison page ("<name> vs <what people use instead>") is what search engines and LLMs cite most. |
| The page | when it truly shipped | `offer_post` once, if the desk has a page (the brief says). |

## Each draft: check before you send it

Say which of these you checked, in the draft's foot:

- **The hour** it should go out, in the user's time and in UTC.
- **The title's length**, counted, against the channel's limit.
- **The disclosure** the channel asks for, if any.
- **One link**, to the thing itself (the repo, the page), not three.
- **Words a person wrote**: no lists of adjectives, no "I'm excited to
  announce", no claims the code does not back.

## After the post

- The user posts. When they say where it went, tick the line with the post's
  URL as `evidence`; `move_thread` with `told` and that `url` marks the
  thread told.
- The numbers a week on (stars, downloads, replies) go on the T+7 line's
  tick as its `say`, with where they came from as its `evidence`.
- Watching whether the project is named by ChatGPT, Claude or Perplexity is
  a routine (`offer_routine`, with the asking put in `waits`), never a thing
  you check on your own.

## Three things not to do

1. **Never post**, sign in, or send anything on your own: draft, and leave
   the line for the user.
2. **Never more than one picture** a post, and never five posts in a day.
   No vote rings, no asking friends to upvote: a flagged account is gone.
3. **Never a second `offer_post`** for the same thing: it only updates the
   card.
