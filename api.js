/*
 * api.js — talks to the Animal GIFs backend.
 *
 * The backend keeps the GIPHY API key private and returns a small,
 * frontend-safe GIF representation:
 *
 * {
 *   data: [
 *     {
 *       id: string,
 *       url: string,
 *       width?: number|string,
 *       height?: number|string
 *     }
 *   ],
 *   cached?: boolean
 * }
 */

"use strict";

const Api = {
  /**
   * Fetch funny GIFs for an animal from our backend.
   *
   * @param {string} animal
   *   Animal name. Validation is performed by app.js.
   *
   * @param {number} [offset=0]
   *   Number of results to skip for pagination.
   *
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   *   Optional AbortSignal used to cancel stale requests.
   *
   * @returns {Promise<Array<{
   *   id: string,
   *   url: string,
   *   width?: number,
   *   height?: number
   * }>>}
   *
   * @throws {Error}
   *   If the request fails or the backend returns an error.
   *
   * @throws {DOMException}
   *   AbortError when the request is intentionally cancelled.
   */
  async searchGifs(animal, offset = 0, options = {}) {
    const endpoint = getEndpoint();

    const params = new URLSearchParams({
      animal: String(animal ?? ""),
      offset: String(offset),
    });

    const url = `${endpoint}?${params.toString()}`;

    const fetchOptions = {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      signal: options.signal,
    };

    let response;

    try {
      response = await fetch(url, fetchOptions);
    } catch (error) {
      /*
       * AbortController cancellation is intentional.
       *
       * Do not replace AbortError with our generic network error because
       * app.js uses it to distinguish cancellation from a real failure.
       */
      if (error?.name === "AbortError") {
        throw error;
      }

      throw new Error(
        "Could not reach the server. Is it running?"
      );
    }

    const payload = await parseJsonResponse(response);

    if (!response.ok) {
      const message =
        typeof payload?.error === "string" &&
        payload.error.trim()
          ? payload.error.trim()
          : `Request failed (HTTP ${response.status}).`;

      throw new Error(message);
    }

    return normalizeGifList(payload?.data);
  },
};


/* ================================================================
 * Helpers
 * ================================================================ */

/**
 * Get and validate the configured GIF endpoint.
 *
 * @returns {string}
 */
function getEndpoint() {
  const endpoint =
    typeof CONFIG !== "undefined"
      ? CONFIG.GIFS_ENDPOINT
      : null;

  if (
    typeof endpoint !== "string" ||
    !endpoint.trim()
  ) {
    throw new Error(
      "GIF API endpoint is not configured."
    );
  }

  return endpoint.trim();
}


/**
 * Parse a JSON response safely.
 *
 * @param {Response} response
 * @returns {Promise<object>}
 */
async function parseJsonResponse(response) {
  let payload;

  try {
    payload = await response.json();
  } catch {
    /*
     * A malformed response is different from a network failure.
     */
    throw new Error(
      "Unexpected server response. Start the Flask server."
    );
  }

  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw new Error(
      "Unexpected server response from the GIF service."
    );
  }

  return payload;
}


/**
 * Normalize and validate the GIF list returned by the backend.
 *
 * The backend is trusted to return clean data, but validating here makes
 * the frontend more resilient if the API changes or returns malformed data.
 *
 * @param {unknown} data
 * @returns {Array<{
 *   id: string,
 *   url: string,
 *   width?: number,
 *   height?: number
 * }>}
 */
function normalizeGifList(data) {
  if (!Array.isArray(data)) {
    return [];
  }

  const result = [];

  for (const item of data) {
    if (
      !item ||
      typeof item !== "object"
    ) {
      continue;
    }

    const id = normalizeString(item.id);
    const url = normalizeString(item.url);

    if (!id || !url) {
      continue;
    }

    /*
     * Only accept HTTP(S) URLs.
     *
     * This prevents malformed values such as:
     *   javascript:...
     *   data:...
     */
    if (!isSafeHttpUrl(url)) {
      continue;
    }

    const gif = {
      id,
      url,
    };

    const width = normalizeDimension(item.width);
    const height = normalizeDimension(item.height);

    if (width !== undefined) {
      gif.width = width;
    }

    if (height !== undefined) {
      gif.height = height;
    }

    result.push(gif);
  }

  return result;
}


/**
 * Normalize a string-like value.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeString(value) {
  if (
    typeof value !== "string" &&
    typeof value !== "number"
  ) {
    return "";
  }

  return String(value).trim();
}


/**
 * Validate a GIF URL.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isSafeHttpUrl(value) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" ||
      url.protocol === "http:"
    );
  } catch {
    return false;
  }
}


/**
 * Convert a GIF dimension to a positive finite number.
 *
 * @param {unknown} value
 * @returns {number|undefined}
 */
function normalizeDimension(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return undefined;
  }

  const number = Number(value);

  if (
    !Number.isFinite(number) ||
    number <= 0
  ) {
    return undefined;
  }

  return number;
}
