export class ExtensionError extends Error {
  constructor(code, options = {}) {
    super(code);
    this.name = "ExtensionError";
    this.code = code;
    this.retryable = options.retryable === true;
  }
}

export function fail(code, options) {
  throw new ExtensionError(code, options);
}

export function toPublicError(error) {
  if (error instanceof ExtensionError) {
    return { code: error.code, retryable: error.retryable };
  }

  return { code: "INTERNAL_ERROR", retryable: false };
}

