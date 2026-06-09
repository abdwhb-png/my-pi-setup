---
name: youtube-analysis
description: Analyze, summarize, extract learnings from, or understand a YouTube video.
---

# YouTube Analysis

## Overview
This skill outlines the process for fully analyzing a YouTube video by leveraging transcripts, metadata, and external context referenced in the video description. It transforms a simple "summarize this video" request into a comprehensive analysis.

## When to Use
- User asks for a summary of a YouTube video.
- User wants to learn from a YouTube video or extract key insights.
- User asks questions about the content of a specific YouTube video.
- You need to understand a video's content to perform a task (e.g., "implement the technique from this video").

## Core Process

### 1. Retrieve Video Metadata
First, get the high-level context of the video.
- **Tool:** `mcp({ server: "youtube-mcp", tool: "get_video_info", args: '{"url": "..."}' })`
- **Action:** Call with the video URL.
- **Why:** To get the title, channel name, and importantly, the **description**. The description often contains valid citation links, project repos, or related articles that are crucial for full understanding.

### 2. Retrieve Transcript
Get the actual content of the video.
- **Tool:** `mcp({ server: "youtube-mcp", tool: "get_timed_transcript", args: '{"url": "..."}' })` (preferred) or `mcp({ server: "youtube-mcp", tool: "get_transcript", args: '{"url": "..."}' })`
- **Action:** Call with the video URL.
- **Why:** The transcript provides the spoken content with timestamps.

### 3. Analyze Description for External Context
Don't just rely on the video; look at what the author linked.
- **Action:** Parse the `description` from Step 1.
- **Filter:** Identify *informational* links (e.g., GitHub repos, blog posts, documentation, news articles).
- **Ignore:** Social media profiles (Twitter/Instagram), sponsor links (Patreon, Merch), and generic platform links unless relevant to the user's specific query.
- **Instruction:** If the user wants a "full analysis" or "deep dive," or if the video is technical/tutorial-based, you **MUST** fetch content from 1-3 of the most relevant informational links.

### 4. Fetch External Content (Contextual)
If relevant links were found and are needed for the analysis:
- **Tool:** `fetch_content({ url: "..." })` for web pages and articles.
- **Fallback:** If fetching fails (e.g., URL shorteners, 403 errors), use `web_search` with the title or citation text from the description to find the resource.
- **Action:** Fetch the content of the selected links.
- **Why:** To cross-reference claims, get code samples that might be hard to read from a transcript, or understand the broader context.

### 5. Visual Analysis (Gemini)
Additionally, complement the textual information with visual understanding of the video content.
- **Tool:** `fetch_content({ url: "youtube-url", prompt: "describe what's shown on screen" })`
- **Action:** Call with the YouTube URL and a specific prompt about the visual content.
- **Why:** To understand diagrams, code shown on screen, UI demos, or any visual elements the transcript doesn't capture.

### 6. Supplement with Code/Web Research
- **Tool:** `code_search({ query: "..." })` to find relevant code documentation or examples related to the video topic.
- **Tool:** `web_search({ query: "..." })` for supplementary context or current information.
- **Why:** To provide verified, up-to-date context beyond what the video covers.

### 7. Synthesize & Analyze
Combine all sources to generate the final response.
- **Context Sources:**
  1. Video Metadata (Who, What, When)
  2. Transcript (The Core Content)
  3. Visual Analysis (What's on Screen)
  4. External Links (Validation/Deep Dive/Code)
  5. Supplementary Research (Current best practices)
- **Output:** Structure the analysis based on the user's request (e.g., "Key Takeaways," "Step-by-Step Guide," "Code Implementation").
- **Citation:** Explicitly mention if information came from the video, a linked resource, or external research.

## Example Workflow

User: "Summarize this lecture on new AI agents: [URL]"

**Agent Actions:**
1. `mcp({ server: "youtube-mcp", tool: "get_video_info", args: '{"url": "..."}' })` → Returns title "AI Agents 2.0" and description with links to a paper and a GitHub repo.
2. `mcp({ server: "youtube-mcp", tool: "get_timed_transcript", args: '{"url": "..."}' })` → Returns the lecture text with timestamps.
3. `fetch_content({ url: "youtube-url", prompt: "what diagrams and architectures are shown?" })` → Returns visual analysis of on-screen content.
4. **Internal Logic:** Identify the paper link (arxiv.org) and GitHub link as high-value context.
5. `fetch_content({ url: paper_url })` → Fetches abstract/intro of the paper.
6. `code_search({ query: "topic from video implementation" })` → Finds related code patterns.
7. **Synthesis:** Generates a summary that integrates the lecture's points with visual context, formal definitions from the paper, and current best practices — providing a verified and richer answer than the transcript alone.

## Common Mistakes
- **Ignoring the Description:** Failing to check links means missing code repos or source papers.
- **Skipping Visual Analysis:** Relying only on text misses diagrams, demos, and code shown on screen.
- **Fetching Irrelevant Links:** Wasting tokens on sponsor links or social media.
- **Over-Reliance on Transcript:** Transcripts can have errors or lack visual context; external documentation links and Gemini visual analysis resolve this ambiguity.
- **Not Using Timestamps:** The timed transcript helps pin exact moments for frame extraction or visual analysis.