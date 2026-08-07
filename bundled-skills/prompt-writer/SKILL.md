---
name: prompt-writer
description: >-
  Methodology for writing or improving prompts and system prompts that drive any LLM. Use when authoring or revising a prompt for a model task — grouping, classification, extraction, generation, copywriting, labeling, agent instructions, prompt templates, skill instructions — to decide how much to constrain the model based on the task type (open-ended vs single-correct-answer) and write the most fitting instructions. Triggers: "write a prompt", "help me write or improve a prompt", "how should I change this prompt", "this prompt isn't working", "write instructions for the model", "prompt-writer". Not for: answering the user's question directly, or writing articles and documents meant for human readers (those are not prompts that drive a model).
metadata:
  author: MyAgents
  version: "20260707"
---

# Prompt Writer

A prompt's job is not to spell out every rule. The context window is a public good, so aim for the smallest set of high-signal tokens that maximize the likelihood of the output you want. The more rules you write, the more you box the output into the range of things you happened to think of. Assume the model is already very smart and only add context it doesn't already have — challenge every line: does this paragraph justify its token cost, or can I assume the model knows this?

## First, set the degrees of freedom

The most important decision is how much latitude to give the model: match the level of specificity to the task's fragility and variability. Picture the model exploring a path. On a narrow bridge with cliffs on both sides there is only one safe way forward, so give exact instructions and specific guardrails — this is low freedom, and it fits schemas, data formats, migrations, API calls, anything where a small error makes the output unusable. In an open field with no hazards many paths lead to success, so give general direction and trust the model to find the route — this is high freedom, and it fits grouping, generation, copywriting, subjective judgment, anything where several outputs are valid and quality is a judgment call.

Get this wrong and everything downstream is wrong. Write an open-field task with narrow-bridge language and the model collapses to the most generic result; write a narrow-bridge task with open-field language and it improvises where it must not.

| | High freedom (open field) | Low freedom (narrow bridge) |
|---|---|---|
| When | Several valid outputs; quality is a judgment call | One correct output; small errors break it |
| Examples | Grouping, generation, copywriting, subjective rating | Schemas, data formats, migrations, API calls |
| How | Goal + role + canonical examples | Exact steps + strict template |
| Trade-off | Trust the model's judgment, fewer rules | Constrain with rules, leave no room to improvise |

Most real prompts mix both modes. An agent prompt leaves the approach open but locks the tool-call format; a generation task gives free rein on content but demands strict JSON out. Zone the prompt instead of picking one mode for the whole thing: narrow-bridge treatment for formats, schemas, and tool calls; open-field treatment for content and judgment. And calibrate to the model that will run the prompt — the weaker the model, the more everything shifts toward the narrow bridge.

## Find the right altitude

Within either mode, aim for the right altitude: specific enough to guide behavior, flexible enough to leave the model strong heuristics. Too low is hardcoding brittle logic — "if the title contains a colon, split on it and capitalize the second half." Too high is vague guidance with no concrete signal — "write good titles." The altitude that works sits between the two: "make titles specific and punchy over comprehensive; here is a weak one and a strong one."

## Principles for both modes

- Think of the model as a brilliant but new employee who lacks context on your norms and workflows. Tell it what you want and why — it is smart enough to generalize from the explanation.
- Prefer general instructions over prescriptive steps. The model's reasoning frequently exceeds what a human would prescribe, so a clear goal often beats a hand-written step-by-step plan.
- Tell the model what to do, not what not to do. And match your prompt's style to the output you want — the formatting you use tends to come back in the response.
- The colleague test: show the prompt to someone with minimal context and ask them to follow it. If they would be confused, the model will be too.

## Examples do more than rules

Examples are one of the most reliable ways to steer output format, tone, and structure — they are the pictures worth a thousand words, and they convey the desired style and level of detail more clearly than descriptions alone. How many depends on what you are steering: to pin down a specific output shape or format, give three to five diverse, canonical examples; to convey a taste or a quality bar on an open task, one or two strong weak-output-versus-strong-output pairs is enough, and more would over-anchor the model. Either way, a good example usually beats ten rules, and it won't cap the model the way rules do.

## High-freedom tasks

State the role and the goal in one line and let the model generalize. Give direction plus one or two strong weak-vs-strong example pairs, not a rulebook. Keep to a couple of canonical examples and a single sensible default with an escape hatch, rather than piling on edge cases or options. For format, say "here is a sensible default, but use your best judgment" rather than fixing every field. Go easy on emphasis: on current models, what used to need "CRITICAL: You MUST..." now works better as a plain "Use this when...", because heavy emphasis makes them overtrigger and lose range.

## Low-freedom tasks

Give exact steps and a strict template — "always use this exact structure" — and add a script when the operation must be deterministic. Put the critical constraints first; emphasis markers are appropriate here. Build in verification: run the validator, fix errors, repeat. With no execution loop — a bare single-shot prompt — have the model emit its answer, then re-read it against the schema and correct it before finalizing. For long inputs, have the model quote the relevant parts first to ground its work.

## Review before you ship

Switch to an auditing frame and go line by line. Is it an open field or a narrow bridge, and does the specificity match? Is this the smallest set of high-signal tokens, or did I write things the model already knows? Can any rule be replaced by an example? Then approach it scientifically and test on diverse inputs, including one that flatters the prompt and one that exposes it — testing a single good case is not testing.

## When a prompt isn't working

Get failing examples in hand before touching anything — a fix without a failure to test against is a guess. Then read the failure against the freedom axis, because most bad outputs are one of three misfits. Output collapsed to the generic average: an open-field task strangled by narrow-bridge rules — delete rules and show a strong example instead. Model improvising where it must not: an open-field prompt on a narrow-bridge task — tighten the template and build in verification. Right direction but mediocre: the model lacks context you have, or a single example is over-anchoring it — add the missing why, or diversify the examples. Re-test on the inputs that failed, plus one that used to work.

## Worked example: rules vs examples on the same task

Task: write three titles for an article on remote teams.

- Rules-driven — told to keep titles short, accurate, free of clickbait, and on-topic — the model returns the safe skeleton: "A Guide to Remote Team Productivity." Correct, generic, forgettable; the title anyone would write.
- Example-driven — shown one weak title ("Tips for Remote Work") next to one strong one ("Your 9am standup is killing your team") — the model picks up the angle and proposes "Why your remote team goes quiet after lunch." Specific, with a hook a reader actually clicks.

The difference is the prompt, not the model. A rule list describes a generic average, and the model gives you exactly that; one strong weak-vs-strong pair shows the bar and lets the model's judgment reach it.

## Source material

- Effective context engineering for AI agents — anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Prompting best practices (latest models) — platform.claude.com/docs/en/docs/build-with-claude/prompt-engineering/claude-4-best-practices
- Skill authoring best practices — platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
- Writing effective tools for AI agents — anthropic.com/engineering/writing-tools-for-agents
