# DDAF (Domain-Driven Agentic Framework) - Opencode

A fork of [opencode](https://github.com/opencode-ai/opencode) that implements **domain-centered agent specialization** with a single rolling memory, stateless LLM classification, and aggressive context management — designed to keep the context window small, clean, and focused at every turn.

---

## Table of Contents

- [Motivation](#motivation)
- [Core Architecture](#core-architecture)
- [Request Lifecycle](#request-lifecycle)
- [Domain Definitions](#domain-definitions)
- [Stateless LLM Classifier](#stateless-llm-classifier)
- [Single Rolling Memory](#single-rolling-memory)
- [Conversation Trimming](#conversation-trimming)
- [Domain-Scoped Tool Filtering](#domain-scoped-tool-filtering)
- [How DDAF Improves the Agentic Flow](#how-ddaf-improves-the-agentic-flow)
- [Implemented Modules](#implemented-modules)
- [Modified Files](#modified-files)
- [How to Expand](#how-to-expand)
- [Configuration Reference](#configuration-reference)
- [Original Ideas](#original-ideas)

---

## Motivation

Standard agentic coding assistants suffer from **context saturation**: the system prompt, tool definitions, conversation history, and memory all compete for the same limited token window. As conversations grow, the model receives increasingly noisy input — tools it doesn't need, stale messages from unrelated tasks, and bloated system prompts.

DDAF solves this by applying **domain-driven design** to the agentic loop:

1. **Classify** the user's intent into a domain (coding, research, database, etc.)
2. **Inject only** that domain's prompt, tools, MCPs, and skills
3. **Trim** the conversation to only the current turn
4. **Preserve** all prior knowledge in a single, continuously updated memory summary
5. **Route** every turn through a lightweight, stateless LLM call — no keyword heuristics, no accumulated state

The result: a **near-constant context window** regardless of how many turns have passed or how many domains the conversation has crossed.

---

## Core Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      User Message                       │
└───────────────────────────┬─────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│               Stateless LLM Classifier                  │
│  • Receives ONLY the latest user message                │
│  • Returns a single domain name (e.g. "coding")        │
│  • ~177 tokens per call — constant size                 │
│  • Falls back to "general" on error                     │
└───────────────────────────┬─────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                  DomainPrompt.resolve                    │
│  • Loads domain-specific system prompt                  │
│  • Retrieves single rolling memory summary              │
│  • Filters skills by domain (RAG-style)                 │
│  • Returns tool/MCP whitelists                          │
└───────────────────────────┬─────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                 SessionPrompt.runLoop                    │
│  • Replaces provider prompt with domain prompt          │
│  • Trims conversation to last user turn only            │
│  • Filters tools/MCPs by domain whitelist               │
│  • Preserves internal tools (question, batch, etc.)     │
│  • Injects <memory> and <context> blocks                │
└───────────────────────────┬─────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                 LLM Completion Call                      │
│  • Compact system prompt (~500–1500 tokens)             │
│  • Only relevant tools (3–12 instead of 30+)            │
│  • Only current turn messages                           │
│  • Memory summary providing full conversation history   │
└───────────────────────────┬─────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                    Memory.add (async)                    │
│  • After loop completes, summarizes the conversation    │
│  • LLM merges new excerpt into existing rolling summary │
│  • Persists to ~/.opencode/data/memory.json             │
└─────────────────────────────────────────────────────────┘
```

---

## Request Lifecycle

Every user message goes through this exact sequence:

1. **Extract query** — only the **last** user message is extracted (`msgs.findLast`), capped at 500 chars. This prevents the classifier from seeing stale history.

2. **Classify** — a single `generateText` call with `temperature: 0` and `maxTokens: 20` asks the LLM to output one domain name. The system prompt lists all available domains with descriptions. Cost: ~177 tokens.

3. **Resolve domain** — `DomainPrompt.resolve` loads the matched domain's system prompt, retrieves the memory summary, and filters available skills.

4. **Override agent prompt** — the domain's compact prompt replaces the default provider prompt (e.g. `anthropic.txt` which can be 3000+ tokens). This alone saves thousands of tokens per turn.

5. **Trim messages** — only messages from the last user turn onward are kept. A `<context>` tag tells the model that earlier conversation is summarized in memory.

6. **Filter tools** — tools not in the domain's whitelist are removed. Internal tools (`question`, `batch`, `plan_exit`, `invalid`) are always preserved.

7. **Filter MCPs** — MCP tools not matching the domain's MCP prefixes are removed.

8. **Call LLM** — the model receives a minimal, focused prompt with only relevant context.

9. **Auto-memorize** — after the loop completes, the last 1500 chars of conversation are merged into the rolling memory via an LLM summarization call.

---

## Domain Definitions

Domains are defined as Markdown files with YAML frontmatter. Place them in:

- `.opencode/domains/` or `.opencode/domain/` (project-level)
- Or inline in `opencode.jsonc` under the `domains` key

### Example: `.opencode/domains/coding.md`

```markdown
---
name: coding
description: Software development, code editing, debugging, refactoring, and code review
tools:
  - bash
  - read
  - glob
  - grep
  - edit
  - write
  - codesearch
  - lsp
  - apply_patch
  - task
  - skill
---

You are an expert software engineer. You MUST use your tools to perform actions — never just describe what to do.

Rules:
- Always act using tools, never just explain
- Use write to create new files
- Use edit to modify existing files
- Use bash to run commands
- Use read to inspect files before editing
```

### Example: `.opencode/domains/research.md`

```markdown
---
name: research
description: Online research, web searching, information gathering, and document analysis
tools:
  - websearch
  - webfetch
  - read
  - bash
  - skill
---

You are a research assistant. Focus on finding accurate, up-to-date information.

When researching:
- Use web search to find relevant sources
- Verify information from multiple sources when possible
- Cite your sources
- Present findings in a structured format
```

### Frontmatter Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | **yes** | Unique domain identifier |
| `description` | `string` | **yes** | Used by the classifier to determine the best domain for a query |
| `tools` | `string[]` | no | Tool IDs available in this domain. Omit to allow all tools. |
| `mcps` | `string[]` | no | MCP server name prefixes available in this domain |
| `skills` | `string[]` | no | Skill names available in this domain |
| `keywords` | `string[]` | no | Legacy field (kept for compatibility, not used by the stateless classifier) |
| `permission` | `object` | no | Domain-specific permission overrides |

The **body** of the markdown file (below the frontmatter) becomes the domain's system prompt.

### The `general` Fallback Domain

If no domain matches or classification fails, the `general` fallback is used automatically. It has:
- A minimal system prompt: `"You are an AI coding assistant. Help the user with their request. Be concise and direct."`
- An empty tool whitelist (`[]`), meaning only internal tools are available
- No MCP or skill filtering

You can override the fallback by defining a domain named `general` in your domains directory.

---

## Stateless LLM Classifier

**Module**: `packages/opencode/src/domain/classifier.ts`

The classifier is **stateless** — it has no memory of previous classifications, no keyword tables, and no accumulated state. Each turn is classified independently based solely on the latest user message.

### How it works

1. Build a catalog string from all domain names and descriptions:
   ```
   - coding: Software development, code editing, debugging
   - research: Online research, web searching, information gathering
   - database: Database design, queries, migrations
   - general: General-purpose domain for queries that do not match any specific domain
   ```

2. Send a `generateText` call with:
   - **System**: `"Classify the user query into exactly one domain. Reply with ONLY the domain name, nothing else.\n\nDomains:\n{catalog}"`
   - **User**: the last user message (up to 500 chars)
   - `temperature: 0`, `maxTokens: 20`

3. Parse the response: find the first known domain name in the output. Fall back to `general` if none matches.

### Why stateless?

- **Constant token cost**: ~177 tokens regardless of conversation length
- **No drift**: each turn is classified fresh, so switching topics mid-conversation works correctly
- **No maintenance**: no keyword lists to maintain or tune
- **Robust with local models**: simple text output is more reliable than structured JSON output with small models

### Overhead

The classifier adds one lightweight LLM call per turn (~170ms with a local model). For remote API models this is typically <100ms. This is negligible compared to the main completion call.

---

## Single Rolling Memory

**Module**: `packages/opencode/src/memory/index.ts`

All conversation history across all domains is condensed into a **single, continuously updated summary** stored in `~/.opencode/data/memory.json`.

### Storage format (v2)

```json
{
  "version": 2,
  "summary": "User has been working on a Python script for Drosophila gene visualization. Previously created hello.py, researched humeral mutations in Drosophila melanogaster, found information about the hu gene on chromosome 3..."
}
```

### How merging works

After each completed turn:

1. The last 1500 characters of the conversation (user + assistant messages) are extracted
2. If the summary is empty, the excerpt is stored directly (capped at 2000 chars)
3. If a summary already exists, an LLM merge call combines them:
   - **System prompt**: `"You are a memory summarizer. Merge the existing summary and new conversation excerpt into a single concise summary (max ~500 words). Keep facts, decisions, code written, tools used, and user preferences."`
   - **User content**: `<existing_summary>...</existing_summary>\n\n<new_conversation>...</new_conversation>`
4. If the merge LLM call fails, a simple concatenation fallback is used (last 2000 chars)

### Why a single summary?

A previous idea was to store **per-domain memory entries** with keywords and concepts. This caused information loss when:
- A user switched domains mid-conversation (research → coding)
- Context from one domain was needed in another (e.g., "write a script about the gene you just found")
- Keyword matching missed relevant entries

The single rolling summary ensures **all context is always available**, regardless of which domain is currently active.

### Injection

The memory summary is injected into the system prompt as:

```xml
<memory>
User has been working on... [full summary]
</memory>
```

This gives the model awareness of the entire conversation history in a compact format.

---

## Conversation Trimming

**Location**: `packages/opencode/src/session/prompt.ts` (lines 1526–1543)

To prevent the conversation history from growing unboundedly, DDAF trims the message array to **only the current turn** — from the last user message onward.

When trimming occurs, a context tag is injected:

```xml
<context>Earlier conversation was summarized in the memory blocks above. Only recent messages follow.</context>
```

This tells the model that it has access to the full history via the `<memory>` block, even though only recent messages are present.

### What gets trimmed

- All user messages before the last one
- All assistant responses to those earlier messages
- All tool call/result pairs from previous turns

### What is preserved

- The current user message
- Any tool calls and results from the current turn
- The domain system prompt
- The memory summary
- Environment information

---

## Domain-Scoped Tool Filtering

**Location**: `packages/opencode/src/session/prompt.ts` (lines 1547–1568)

Each domain specifies a `tools` whitelist. When a domain is active, **only those tools are available to the model**. This dramatically reduces the token count of tool definitions in the prompt.

### Example token savings

| Scenario | Tools | Approx. tool definition tokens |
|----------|-------|-------------------------------|
| No filtering (all tools) | 30+ | ~4000–6000 |
| Coding domain | 11 | ~1500–2000 |
| Research domain | 5 | ~800–1000 |
| General fallback | 0 (+ 4 internal) | ~400 |

### Internal tools always preserved

These tools are **never filtered out**, regardless of domain:
- `invalid` — error handling
- `question` — ask the user clarifying questions
- `batch` — batch operations
- `plan_exit` — planning flow control

### MCP filtering

If a domain specifies `mcps: ["server-a"]`, only MCP tools whose names start with `server-a` are kept. This prevents MCP tools from other servers leaking into the context.

---

## How DDAF Improves the Agentic Flow

### The Problem: Context Saturation

Traditional agentic assistants accumulate context linearly:

```
Turn 1:  System(3000) + Tools(5000) + Msg(200)           = ~8200 tokens
Turn 2:  System(3000) + Tools(5000) + Msg(200+800)       = ~9000 tokens
Turn 5:  System(3000) + Tools(5000) + Msg(200+800+...N)  = ~14000+ tokens
Turn 10: System(3000) + Tools(5000) + Msg(...)            = ~25000+ tokens → OVERFLOW
```

With small local models (4K–8K context), this overflows within a few turns. With large models, it still degrades quality because the model attends to irrelevant context.

### The DDAF Solution: Near-Constant Context

```
Turn 1:  DomainPrompt(200) + ScopedTools(1500) + Memory(0) + Msg(200)     = ~1900 tokens
Turn 2:  DomainPrompt(200) + ScopedTools(1500) + Memory(300) + Msg(200)   = ~2200 tokens
Turn 5:  DomainPrompt(200) + ScopedTools(800)  + Memory(500) + Msg(200)   = ~1700 tokens
Turn 10: DomainPrompt(200) + ScopedTools(1500) + Memory(500) + Msg(300)   = ~2500 tokens
Turn 50: DomainPrompt(200) + ScopedTools(1500) + Memory(500) + Msg(200)   = ~2400 tokens
```

The context grows slightly as the memory summary accumulates, but it is **bounded at ~500 words** by the merge prompt, and the conversation messages are trimmed to a single turn. The result is a **near-constant context window of ~2000–5000 tokens** (depending on tool count and domain prompt size).

### Key benefits

- **Works with small models**: 4K–8K context models can sustain multi-turn conversations without overflow
- **Clean domain switching**: switching from research to coding doesn't carry stale tool calls or irrelevant system prompts
- **No cross-domain leakage**: a `tool_calls` block from a research turn won't confuse the coding domain's model
- **Faster inference**: smaller prompts mean faster prompt processing (1500 tokens vs 8000+ tokens)
- **Better tool use**: the model sees only 5–11 relevant tools instead of 30+, leading to more accurate tool selection
- **Persistent knowledge**: the rolling memory ensures nothing is lost — even facts from 50 turns ago are available via the summary
- **Stateless per turn**: each turn is independently classified and assembled, so there's no accumulated error or drift

### Measured token counts (from real logs with Gemma 4 E4B)

| Request type | Tokens |
|-------------|--------|
| Classifier call | 177 |
| Research domain (fresh, no tools) | 4687 |
| Research domain (with tool results) | 6023 |
| Coding domain (minimal) | ~4800 |
| General fallback (no tools) | 1075 |
| Memory merge call | ~630 |

The main completion calls stay in the **4600–6100 token range** even after many turns, with variations coming from tool result sizes (which are inherently variable) rather than accumulated history.

---

## Implemented Modules

### New files

| Module | Path | Description |
|--------|------|-------------|
| **Domain** | `src/domain/index.ts` | Domain schema (Zod), loading from `.opencode/domains/*.md` and `opencode.jsonc`, fallback domain definition. Uses `InstanceState` for per-project state. |
| **Classifier** | `src/domain/classifier.ts` | Stateless LLM-based query classification. Single `generateText` call per turn. Falls back to `general` on error. |
| **DomainPrompt** | `src/domain/prompt.ts` | Orchestrator: calls classifier, retrieves memory, filters skills, builds domain system prompt. Exposes `resolve()` and `memorize()`. |
| **Memory** | `src/memory/index.ts` | Single rolling summary store. LLM-based merge of new conversation excerpts. v1→v2 migration support. Persists to `memory.json`. |

### Modified files

| File | Changes |
|------|---------|
| `src/config/config.ts` | Added `domains` and `memory` configuration schemas |
| `src/session/prompt.ts` | Integrated domain-aware prompt assembly: query extraction (last message only), domain resolution, prompt override, conversation trimming, tool filtering, MCP filtering, auto-memorization after loop completion |

### Domain definition files (examples)

| File | Domain |
|------|--------|
| `.opencode/domains/coding.md` | Software development — tools: bash, read, edit, write, grep, codesearch, lsp, etc. |
| `.opencode/domains/research.md` | Online research — tools: websearch, webfetch, read, bash |
| `.opencode/domains/database.md` | Database work — tools: bash, read, edit, write, glob, grep |

---

## How to Expand

### Adding a new domain

Create a new `.md` file in `.opencode/domains/`:

```markdown
---
name: devops
description: Infrastructure, CI/CD, Docker, Kubernetes, cloud deployment, and monitoring
tools:
  - bash
  - read
  - edit
  - write
  - glob
  - grep
skills:
  - docker
  - kubernetes
---

You are a DevOps engineer. Focus on infrastructure automation, reliability, and security.

When working on infrastructure:
- Always check existing configurations before making changes
- Use infrastructure-as-code principles
- Consider security implications of every change
- Prefer declarative configurations over imperative scripts
```

That's it. The classifier will automatically include the new domain in its catalog on the next turn.

### Adding MCP-specific domains

If you have MCP servers configured, you can scope them to domains:

```markdown
---
name: data-analysis
description: Data analysis, visualization, and statistical computation
tools:
  - bash
  - read
  - write
mcps:
  - jupyter
  - pandas-server
---

You are a data analyst. Use the Jupyter and pandas MCP servers for computation.
```

Only MCP tools whose names start with `jupyter` or `pandas-server` will be available in this domain.

### Customizing the fallback domain

Create `.opencode/domains/general.md`:

```markdown
---
name: general
description: General conversation, questions, and tasks that don't fit other domains
tools:
  - bash
  - read
---

You are a helpful assistant. For general questions, answer directly.
If the user's request involves code, research, or databases, suggest they rephrase their question for better routing.
```

### Expanding the memory system

The current memory implementation uses a single rolling summary. Possible expansions:

- **Structured memory fields**: extend the `Store` schema with `topics`, `entities`, or `decisions` arrays alongside the summary, each maintained by the merge LLM
- **Memory decay**: add timestamps and reduce the weight of older information during merging
- **Per-project memory**: use `InstanceState` to maintain separate memory per project directory (partially supported already via the file path)
- **Vector retrieval**: store embedding vectors alongside the summary for semantic retrieval of specific facts
- **Memory capacity control**: add a configurable max word count for the summary (currently ~500 words via the merge prompt)
- **User-managed memory**: expose commands to view, edit, or clear the memory summary

### Expanding the classifier

- **Confidence scoring**: have the classifier return a confidence score and fall back to `general` below a threshold
- **Multi-domain routing**: allow the classifier to return multiple domains for queries that span areas (e.g., "write a script to query the database")
- **Custom classifier models**: allow configuring a separate, smaller model specifically for classification
- **Classification caching**: cache recent classifications to avoid redundant LLM calls for repeated/similar queries

### Expanding domain capabilities

- **Domain-specific permissions**: the `permission` frontmatter field is parsed but not yet enforced. Implement per-domain permission policies (e.g., research domain is read-only)
- **Domain chaining**: allow a domain to delegate sub-tasks to another domain (e.g., research finds information, then hands off to coding to write the script)
- **Dynamic tool injection**: allow domains to register tools at runtime based on project context
- **Domain events**: emit events when domains are switched, enabling plugins to react

---

## Configuration Reference

### `opencode.jsonc`

```jsonc
{
  // Domain definitions (alternative to .md files)
  "domains": {
    "coding": {
      "description": "Software development",
      "tools": ["bash", "read", "edit", "write", "grep"]
    }
  },

  // Memory configuration
  "memory": {
    "enabled": true    // set to false to disable memory entirely
  }
}
```

### Environment

| Path | Description |
|------|-------------|
| `~/.opencode/data/memory.json` | Persistent memory store |
| `.opencode/domains/*.md` | Project-level domain definitions |