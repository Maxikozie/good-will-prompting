export class ResourceError extends Error {
  constructor(readonly status: 400 | 413 | 429 | 504, message: string) { super(message); }
}
