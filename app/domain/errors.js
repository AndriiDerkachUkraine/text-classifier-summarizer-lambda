/** Item-level error codes returned as `{ id, error }`; details go to the logs. */
export const ErrorCode = Object.freeze({
  EMPTY_INPUT: 'empty_input',
  INVALID_INPUT: 'invalid_input',
  MODEL_ERROR: 'model_error',
  INVALID_MODEL_OUTPUT: 'invalid_model_output',
  UNSUPPORTED_MODE: 'unsupported_mode',
});

/** Rejects the whole request (bad mode, bad payload, missing key). */
export class RequestError extends Error {
  constructor(message, code = 'bad_request') {
    super(message);
    this.name = 'RequestError';
    this.code = code;
  }
}

/** Fails a single item with one of the ErrorCode values. */
export class ItemError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'ItemError';
    this.code = code;
  }
}
