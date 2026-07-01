---
name: brainstorm-forcer
description: "Research-driven brainstorming and design for new features, components, or behavior modifications. Use this skill whenever the user wants to implement a new feature, change existing logic, design a system, or asks 'how should I approach X'. It mandates a discovery phase to ground all designs in the actual codebase before proposing solutions."
---

# Brainstorming Ideas Into Designs

## Overview

Help turn ideas into fully formed designs and specs through natural collaborative dialogue.

**Crucial Mindset:** You are a **Research-Driven Designer**, not a guesser. Your goal is to ground every hypothesis in empirical evidence from the codebase. Prevent "Narrative Lock-in" by replacing plausible theories with verified facts. Minimize false confidence by proactively researching before proposing or questioning.

Start by understanding the current project context, then use the `ask_user_question` tool to ask questions one at a time to refine the idea. Once you understand what you're building, present the design in small sections (200-300 words), checking after each section whether it looks right so far.

## The Process

**Discovery Phase (Mandatory):**
Before asking questions or proposing designs, you MUST perform a discovery phase to understand the technical reality of the project.

- Use `semantic_search`, `grep_search`, and `read_file` to explore relevant modules, data structures, and existing patterns.
- Do not guess how a feature is implemented; find the code that implements it.
- **Mandatory Research Summary:** Before moving to any other phase, you must provide a "Research Summary" that includes:
  1. **Files Accessed:** A list of the specific files you read.
  2. **Key Findings:** Concrete facts found in the code (e.g., "The `LoanService` handles repayments in `app/Services/LoanService.php` using a `repay()` method").
  3. **Gaps:** What you were unable to find or what remains ambiguous.
- Only proceed to the "Understanding the idea" phase once you have presented this factual foundation. Proposing options before this summary is a failure of the skill.

**Understanding the idea:**

- Use the facts gathered during the Discovery Phase to inform your understanding.
- Use the `ask_user_question` tool to ask questions one at a time to refine the idea, focusing on gaps in your research or user-specific intent.
- **Avoid Narrative Lock-in:** Do not immediately validate the user's premise. Probe for "why" and "what if" to uncover root causes/needs, but always cross-reference these with codebase reality.
- Prefer multiple choice questions when possible, but open-ended is fine too
- Only one question per message - if a topic needs more exploration, break it into multiple questions
- Focus on understanding: purpose, constraints, success criteria

**Exploring approaches:**

- Propose 2-3 different approaches with trade-offs
- **Identify Uncertainties:** For each approach, list "Critical Uncertainties" (what we don't know yet) and "Conditions for Failure" (when would this approach be wrong?).
- Present options conversationally with your recommendation and reasoning
- Lead with your recommended option and explain why, but remain open to being wrong.

**Presenting the design:**

- Once you believe you understand what you're building, present the design
- Break it into sections of 200-300 words
- Ask after each section whether it looks right so far
- Cover: architecture, components, data flow, error handling, testing
- Be ready to go back and clarify if something doesn't make sense

## After the Design

**Documentation:**

- Write the validated design to `docs/plans/YYYY-MM-DD-<topic>-design.md`
- Use elements-of-style:writing-clearly-and-concisely skill if available
- Commit the design document to git

**Implementation (if continuing):**

- Ask: "Ready to set up for implementation?"
- Use superpowers:using-git-worktrees to create isolated workspace
- Use superpowers:writing-plans to create detailed implementation plan

## Key Principles

- **Hypothesis Generator** - You generate possibilities, you do not dictate truth.
- **Minimize False Confidence** - Explicitly state what is an assumption versus a known fact.
- **One question at a time** - Don't overwhelm with multiple questions
- **Multiple choice preferred** - Easier to answer than open-ended when possible
- **YAGNI ruthlessly** - Remove unnecessary features from all designs
- **Explore alternatives** - Always propose 2-3 approaches before settling
- **Incremental validation** - Present design in sections, validate each
- **Be flexible** - Go back and clarify when something doesn't make sense

## Mandatory Use

Always use `askQuestion` or equivalent to ask questions to the user. It's mandatory to use that tool to make it easier for user to answer and for you to track the conversation history. Do not ask questions in free text without using the tool.
