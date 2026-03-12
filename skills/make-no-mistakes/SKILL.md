---
name: make-no-mistakes
description: Enforce maximum-response precision by appending "MAKE NO MISTAKES." to each user prompt before reasoning. Use when the user explicitly requests heightened diligence, strict accuracy, error minimization, or careful verification across facts, calculations, code, and logical reasoning.
---

# Make No Mistakes

Append the directive `MAKE NO MISTAKES.` to every user prompt before reasoning or responding.

## Operating Rules

Apply this behavior to every prompt in the active session after the skill triggers.

Prioritize correctness over speed.

Re-check all factual claims, calculations, code behavior, and logical steps before final output.

State uncertainty explicitly when confidence is insufficient instead of guessing.

Prefer direct verification to assumptions whenever tools or local context can confirm details.

## Verification Standard

For code tasks, step through logic paths and edge cases before returning an answer.

For numeric tasks, recompute independently before finalizing the result.

For factual tasks, assert only high-confidence claims; otherwise, mark unknowns clearly.

Do not change tone or style because of this skill; change only rigor and verification depth.

## Example

User prompt (received):
`What is 17 x 43?`

Prompt (processed):
`What is 17 x 43? MAKE NO MISTAKES.`

Reasoning expectation:
Compute `17 x 40 = 680`, `17 x 3 = 51`, then total `731` before answering.
