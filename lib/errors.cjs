'use strict';

const EXIT = Object.freeze({
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  NOT_LOGGED_IN: 3,
  KEYRING_UNAVAILABLE: 4,
  ZCODE_RUNNING: 5,
  CRYPTO: 6,
});

const EXIT_BY_CODE = Object.freeze({
  USAGE: EXIT.USAGE,
  NOT_LOGGED_IN: EXIT.NOT_LOGGED_IN,
  KEYRING_UNAVAILABLE: EXIT.KEYRING_UNAVAILABLE,
  ZCODE_RUNNING: EXIT.ZCODE_RUNNING,
  CRYPTO: EXIT.CRYPTO,
  BUNDLE_INVALID: EXIT.CRYPTO,
  PASSPHRASE_REQUIRED: EXIT.USAGE,
  CANCELLED: 130,
  UNSUPPORTED_PLATFORM: EXIT.KEYRING_UNAVAILABLE,
  CORRUPT_CREDENTIALS: EXIT.CRYPTO,
  TARGET_KEY_UNAVAILABLE: EXIT.KEYRING_UNAVAILABLE,
  IO: EXIT.GENERIC,
});

class ZcodeSyncError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ZcodeSyncError';
    this.code = code;
    this.exitCode = options.exitCode ?? EXIT_BY_CODE[code] ?? EXIT.GENERIC;
    this.details = options.details;
    this.cause = options.cause;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

function fail(code, message, options) {
  throw new ZcodeSyncError(code, message, options);
}

module.exports = {
  EXIT,
  ZcodeSyncError,
  fail,
};
