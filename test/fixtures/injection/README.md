# Prompt-injection attack corpus

The ten numbered Markdown files are synthetic hostile input, not trusted configuration or instructions. They cover instruction overrides, forged owner verification, fake JSON, role switching, Markdown link instructions, HTML comments, delimiter escape, fake tool calls, fenced output and Dutch/French overrides.

`test/security/injection.test.ts` runs each through both evidence and wiki extraction. An adversarial provider deliberately returns forbidden status/score/owner/verification fields; the task boundary must reject it even if the provider ignores its schema argument. Schema-valid claims with fabricated quotes are dropped. The test snapshots real demo facts, scores, source owners and verification tables before and after, and checks prompt delimiters.

These deterministic boundary tests do not establish that an arbitrary live model will resist every semantic injection. Ownership, verification and scoring stay outside the model's output contract. Legitimate extracted claims may still affect downstream decisions; a verbatim quote alone is not proof that a document's claim is true.
