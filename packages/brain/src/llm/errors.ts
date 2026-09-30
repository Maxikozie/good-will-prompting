/** Transport or configuration problem (HTTP error, missing key, timeout). Never includes secrets. */
export class LLMError extends Error {
  override name = 'LLMError';
}

/** The model kept returning output that fails the schema (or `check`) after all retries. */
export class LLMValidationError extends LLMError {
  override name = 'LLMValidationError';
  constructor(
    message: string,
    readonly promptId: string,
    readonly attempts: number,
    readonly lastOutput: string,
  ) {
    super(message);
  }
}

/** FakeProvider has no recorded answer for this call. Fails loudly so tests never silently hit (or skip) a model. */
export class MissingFixtureError extends LLMError {
  override name = 'MissingFixtureError';
  constructor(
    readonly promptId: string,
    readonly inputHash: string,
  ) {
    super(
      `No LLM fixture for prompt "${promptId}" with input hash ${inputHash}. ` +
        `The prompt or its input changed, or the fixture was never recorded. Run \`npm run brain:record\` (real model) and commit the result.`,
    );
  }
}
