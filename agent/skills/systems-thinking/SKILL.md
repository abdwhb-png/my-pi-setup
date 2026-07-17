---
name: systems-thinking
description: Help the user think in systems — map players, incentives, stocks, flows, and feedback loops, then diagnose which type of system they're operating in (Clear / Complicated / Complex / Chaotic) and choose the right response protocol. Use when dealing with multi-stakeholder trade-offs, ambiguous decisions, recurring problems that resist fixes, strategy under uncertainty, or crisis response. Trigger on phrases like "why does this keep happening", "incentives", "second-order effects", "leverage point", "feedback loop", "we're stuck", "system", "the system is broken", or when the user is making a high-stakes decision under uncertainty.
---

# Systems Thinking

Two traditions, one workflow. The **mapping** tradition (RefoundAI/Lenny) teaches you to model a system from outside — players, incentives, stocks/flows, leverage points. The **typology** tradition (Swadia, Cynefin-derived) teaches you to diagnose *what kind of system you're in* before deciding how to act. Use both: diagnose first, then map.

## When to Use

- Multi-stakeholder product or org trade-offs
- "Why does this same problem keep happening?"
- Strategy decisions under uncertainty (hires, pivots, M&A)
- Crisis or incident response — "what kind of system am I in right now?"
- Planning that must account for incentives and feedback loops

## References (Read on Demand)

Load these based on the user's situation:

- **For system-type diagnosis, DART, crisis response, anchor cases** → read [`references/swadia-typology.md`](references/swadia-typology.md).
- **For players & incentives, stocks & flows, leverage points, recurring-pain automation** → read [`references/lenny-mapping.md`](references/lenny-mapping.md).
- **For the 6 underlying podcast quotes behind the mapping tradition** → read [`references/lenny-guest-insights.md`](references/lenny-guest-insights.md).

**Rule of thumb:** *Diagnose type first, then map.* If the situation smells like crisis or genuine uncertainty, start with the typology reference. If the system is stable enough to sit outside and analyze, go straight to the mapping reference.

## How to Help — The 5-Step Workflow

Run these five steps in order. Steps 1–4 are diagnostic; step 5 locks in action. The inline descriptions below are enough for most cases; load the linked reference when the user wants depth.

### 1. Diagnose the system type FIRST (DART)

Before mapping anything, identify what kind of system the user is in. Use the **DART** questions:

- **D — Deconstruct:** Break the problem into sub-parts. Are the parts stable, or shifting?
- **A — Analyze:** What's the cause↔effect relationship? (See table below.)
- **R — Recognize:** Have you seen this pattern before, in this or another system?
- **T — Test:** What's the smallest safe experiment? (Skip T in chaos.)

| System type     | Cause↔effect            | Right response                  | Anchor case                    |
| ---------------- | ----------------------- | ------------------------------- | ------------------------------ |
| **Clear**        | Obvious, repeatable     | Follow checklist, no improv     | Van Halen's brown-M&M's contract |
| **Complicated**  | Exists, but hidden      | Slow down, find the right expert | Hiring pipeline diagnosis     |
| **Complex**      | Known only in hindsight | Run small experiments, adapt    | New product / market entry     |
| **Chaotic**      | Broken, no pattern      | Act first, stabilize, then learn | Tylenol cyanide crisis, 1982  |

Most expensive mistakes in business come from treating one type as another. **Diagnosis is the single highest-leverage move.** → *Depth: [`references/swadia-typology.md`](references/swadia-typology.md)*

### 2. Map the players and incentives

- Identify every player: users, customers, partners, employees, regulators, competitors, your own teammates.
- For each: **what do they want, and what are they incentivized to do?**
- Watch for **incentive traps** (Cobra Effect): when you reward the wrong proxy, people optimize for the reward and against the goal.

> Sriram: *"Think of all the players in the system, think of all of their incentives and how they interact with each other."* → *Depth: [`references/lenny-mapping.md`](references/lenny-mapping.md)*

### 3. Identify stocks and flows

- **Stocks** — things that accumulate (headcount, cash, user trust, technical debt, brand equity).
- **Flows** — movements between states (hires/attrition, revenue/burn, activations/churn).
- Most "stuck" systems are stuck because a stock is being asked to change faster than its flows allow.

> Will Larson: *"Stocks are things that accumulate; flows are the movement from a stock to another thing."* → *Depth: [`references/lenny-mapping.md`](references/lenny-mapping.md)*

### 4. Trace second/third-order effects AND feedback loops

- For each proposed change: what happens next? And after that? And after *that*?
- Look for **delayed feedback loops** — actions whose consequences arrive far later than the reward (the cigarette pattern: satisfaction in seconds, damage in decades). Delayed feedback is the single most under-weighted risk in strategy decisions.
- Classify loops as **reinforcing** (amplify) or **balancing** (dampen).

> Hari Srinivasan: *"The skillsets you need to manage a complicated ecosystem are quite different."*
> Nickey Skarstad: *"Second-order thinking is the ability to think beyond the decisions you're making today."*
> → *Depth: [`references/swadia-typology.md`](references/swadia-typology.md) (delayed feedback) and [`references/lenny-mapping.md`](references/lenny-mapping.md) (n-th order tracing).*

### 5. Find leverage points and prescribe the response

Using what you now know, answer:

- Where is the **constraint** that, if removed, unlocks the most value?
- Is there a **recurring manual pain** worth systematizing or automating?
- Given the system type from step 1: **checklist** (Clear) / **expert consultation** (Complicated) / **small experiment + course-correct** (Complex) / **stabilize-then-analyze** (Chaotic)?

> Melissa Perri + Denise Tilles: *"Tell me about a process you really hated and ended up building a system around."* → *Depth: [`references/lenny-mapping.md`](references/lenny-mapping.md)*

## Questions to Ask the User

**Diagnosis:**

- What kind of system are you in — clear, complicated, complex, or chaotic? How do you know?
- Have you seen this pattern before, anywhere else?

**Mapping:**

- Who are ALL the players, and what does each one actually want?
- What are you rewarding? Is anyone optimizing for the reward instead of the goal?
- What accumulates here (stocks), and what flows between states?

**Effects:**

- If you make this change, what happens next? And then?
- Where are the feedback loops — and how **delayed** are they?
- What constraint, if removed, would unlock the most value?

**Action:**

- What's the smallest test you can run before committing?
- What recurring pain could you systematize?

## Common Mistakes to Flag

- **Skipping system-type diagnosis** — the most expensive mistake. Treating chaos like a complex problem → analysis paralysis. Treating a clear problem like a complex one → wasted cycles.
- **Trusting only first-order effects** — ripples aren't obvious and they compound.
- **Ignoring incentives** — every player responds to their own incentives, not yours. Cobra Effect.
- **Missing delayed feedback loops** — the cost arrives long after the reward.
- **Optimizing locally** — improving one part can make the whole worse.
- **Treating symptoms instead of causes.**
- **Forcing a checklist in chaos** — chaos has no pattern to follow. Act, stabilize, *then* analyze.

## Source Provenance

- **Mapping tradition** → [`references/lenny-mapping.md`](references/lenny-mapping.md) (full principles), [`references/lenny-guest-insights.md`](references/lenny-guest-insights.md) (6 podcast quotes). Source: [`RefoundAI/lenny-skills@main/skills/systems-thinking`](https://github.com/RefoundAI/lenny-skills/tree/main/skills/systems-thinking) — distillations of Seth Godin, Sriram Krishnamurthy, Will Larson, Hari Srinivasan, Nickey Skarstad, Melissa Perri + Denise Tilles.
- **Typology tradition** → [`references/swadia-typology.md`](references/swadia-typology.md). Source: Sandeep Swadia, ["How To Think SO Clearly People Assume You're Brilliant"](https://www.youtube.com/watch?v=mjTgkm-h__M) (YouTube `mjTgkm-h__M`, 2026-06-11). Four-system typology is Cynefin-derived (Dave Snowden); DART framework is Swadia's synthesis.

## Related Skills

- Setting OKRs & Goals
- Defining Product Vision
- Platform Strategy
- Organizational Design