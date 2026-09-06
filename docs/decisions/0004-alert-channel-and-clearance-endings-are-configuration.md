# 0004: The alert channel and the clearance endings are configuration

Status: decided
Decision owner: the implementer, from BRIEF.md
Resolves: BRIEF.md section 9, decision 8 (notification channels for v1 and the
alert message format), in the channel half only
Recorded by: S0036-deal-sentinel-alert-4

Attribution, precisely, because `0001-history-storage-and-layout.md` requires
it: the owner said nothing about either subject. Section 9 lists the channel as
deliberately open and section 4 states the fact about price endings that this
record acts on. Neither half below may be cited as the owner's own words. What
the owner does get is the choice itself, kept open in a form they can exercise
without a code change.

## Decision

**The channel is an operator setting, not a vendor this repository picked.**
`config/alerts.json` carries an endpoint, a method, whatever static headers that
endpoint wants, an optional header for a one-line title and another for the
listing link, and a credential read from a named environment variable. The
committed file carries NO endpoint, so this system delivers nothing until the
owner configures one. No package here names a notification vendor, no dependency
is added for one, and the delivery path is `Governor.request` like every other
byte this system sends.

**The channel's credential travels in a header, and the endpoint's userinfo is
not a second way to supply one.** An endpoint may be a secret in itself - a
webhook URL is a bearer credential wearing a URL's clothes, and the cited
channel documents an `?auth=` parameter of its own - so a credential-bearing
endpoint is accepted and kept out of every string this system reports. The one
shape that is refused rather than redacted is `https://user:password@host/topic`:
a credential inside the URL is quoted back verbatim by the governor's refusal
details and by every transport error the URL appears in, so the channel declines
to send to one and says to move it to `channel.credential`, where it lives in a
header and nowhere else.

The alert MESSAGE FORMAT is decided here, and is not the operator's: every
notification carries the rule that fired, the observed price with its ISO 4217
currency, the reference price it beat with its currency, and the owner's link to
the listing, as plain text in the request body.

**The clearance price endings are the operator's list, and this system asserts
none.** `config/alerts.json` carries a per-source list of price endings, empty
for every source as committed. No ending is written into this tree for any named
retailer. A matched ending is attached to a notification some rule has already
fired, as a tag that says in the alert itself that it corroborated and did not
trigger, and there is no code path from an ending to a notification.

## Reasoning

1. Section 9 lists "Notification channel(s) for v1 and the alert message format"
   as deliberately open, and section 5 recommends without deciding: "ntfy
   (self-hosted, good phone app) is the recommended primary. Apprise as an
   abstraction gives Discord/Pushover/email for free later. A Home Assistant
   webhook unlocks automations ... Starting with just a Discord webhook is also
   fine; the design should make channels additive." Four defensible answers, and
   the owner has not picked one. Hard-coding any of them would spend the owner's
   open decision on the implementer's guess, and would do it in the component
   that decides where the owner's attention goes.

2. Rejected: ship an ntfy client. It is the brief's own recommended primary and
   it loses on what it would cost to be wrong. A vendor-shaped client is a
   dependency, a second configuration shape, and a set of assumptions about
   priorities and topics that a Discord webhook does not share, so the "channels
   are additive" property section 5 asks for would have to be built a second
   time the first time the owner wanted a second channel. An endpoint plus
   headers plus a body reaches ntfy today (its publish documentation is carried
   in this phase's spec as reference material: the body is the message, `X-Title`
   is the title, `X-Click` is the tap target, and `Authorization: Bearer` is the
   credential), and it reaches a Discord webhook, a Home Assistant webhook and an
   Apprise instance with nothing but a different endpoint.

3. Rejected: an abstraction layer over several named channels (the Apprise
   shape). It is the right answer to a problem this system does not have yet:
   one owner, one phone, no channel chosen. The cost is a registry of vendors
   each with its own payload, and every one of them is code that cannot be
   tested against the real service in a suite that is forbidden from leaving
   loopback. A later phase that genuinely needs two channels at once can add one
   over this configuration; nothing here is in its way.

4. Rejected: deriving the message format from configuration too. The four things
   an alert carries are not a preference: the roadmap phase's first assertion
   fixes them, and CLAUDE.md rule 6 says every alert carries its reason. A
   templating system over those four fields would let an owner configure an
   alert that does not say why it fired, which is the failure this phase exists
   to prevent.

5. The clearance endings are configuration for a stronger reason than openness:
   this project has no evidence for any particular ladder. BRIEF.md section 4
   says the famous one "is community lore that is widely reported unreliable in
   2026, so endings should only ever be a weak corroborating tag, never a
   trigger on their own", and section 8 says to "treat all clearance-ending lore
   as heuristics". Writing digits into this tree would be stating a fact the
   brief does not have, which CLAUDE.md rule 8 forbids in the one place where
   being wrong looks exactly like being right: an ending that is not really a
   clearance marker produces a confident tag on an alert about a price that is
   not a deal, and the owner spends money on it.

6. Rejected: no clearance tag at all. The brief asks for the signal and the
   roadmap phase asserts its shape, so removing it would be dropping a
   requirement rather than deciding it. Corroboration is genuinely useful to an
   owner who has learned which endings their own store uses; what is not useful
   is this repository pretending to know.

7. Constraint 7, explicitly: this decision spends nothing and loosens nothing.
   Every channel it can reach is free (self-hosted ntfy, a Discord webhook, a
   Home Assistant webhook on the LAN), so constraint 1 is untouched. The
   delivery path adds outbound traffic from the household's address, which is
   constraint 4's subject, and it is bounded three ways: the notification host
   needs its own ceiling in `config/governor.json` or the governor's first gate
   refuses every attempt, the cooldowns in `config/alerts.json` bound how often
   an alert can be produced at all, and a failed delivery is never retried
   inside a run. Nothing here is an anti-bot-protected target and no ceiling is
   raised. Constraint 2 is untouched: this system spends no money and automates
   no purchase, and an alert is a message to a human who decides.

## Not a deciding factor

- Which channel the implementer would have chosen. The point of the shape is
  that the answer is not in the code.
- Message richness. Markdown, priorities, attachments and action buttons are all
  things the cited channel supports and none of them is required by an
  assertion; a plain-text body that says the four required things reaches every
  candidate channel identically.
- Any published clearance-ending ladder. None was consulted, and none is cited
  anywhere in this repository, on purpose.

## Not decided here

Which channel the owner will actually use, and therefore the rest of section 9
decision 8: that is an act of configuration, and the day it happens nothing in
this repository changes. Nor is anything else in section 9 settled by this
record: not the tuned rules beyond the window low, not seasonal suppression, not
the thresholds, windows and cooldown numbers themselves (which are configuration
and outputs of living with the system, and are committed conservative and
explicitly unvalidated), and not Grafana versus a custom UI.
