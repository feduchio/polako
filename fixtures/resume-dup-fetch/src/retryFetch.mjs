/**
 * retryFetch – wraps a fetch-like function with resume-after-failure support.
 *
 * BUG: when a request fails and is retried, `pending` is never cleared before
 * the retry starts, so the request is sent twice (duplicate fetch on resume).
 */

export class RetryFetcher {
  #pending = false;

  /**
   * @param {(url: string) => Promise<string>} fetchFn - the underlying fetch function
   * @param {number} maxRetries
   */
  constructor(fetchFn, maxRetries = 2) {
    this.fetchFn = fetchFn;
    this.maxRetries = maxRetries;
  }

  /**
   * Fetch url with retry.  Returns the response body string.
   * @param {string} url
   * @returns {Promise<string>}
   */
  async fetch(url) {
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // BUG: on resume (attempt > 0) we set pending again without clearing the
      // previous "pending" flag, so the caller sees it set the whole time.
      // A correct implementation would clear pending before retrying.
      if (this.#pending) {
        // duplicate in-flight detection — but we never reset it on retry
        throw new Error("duplicate in-flight request detected");
      }
      this.#pending = true;
      try {
        const result = await this.fetchFn(url);
        this.#pending = false;
        return result;
      } catch (err) {
        // BUG: missing `this.#pending = false;` here before the retry
        lastError = err;
      }
    }
    this.#pending = false;
    throw lastError;
  }
}
