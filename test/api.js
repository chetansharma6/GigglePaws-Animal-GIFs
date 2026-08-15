import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

describe("Api.searchGifs", () => {
  beforeEach(() => {
    vi.resetModules();

    globalThis.CONFIG = {
      GIFS_ENDPOINT: "/api/gifs",
    };

    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.CONFIG;
    delete globalThis.fetch;
  });

  function mockResponse(body, options = {}) {
    return {
      ok: options.ok ?? true,
      status: options.status ?? 200,
      json: vi.fn().mockResolvedValue(body),
    };
  }

  async function loadApi() {
    await import("../api.js");
    return globalThis.Api;
  }

  it("calls the configured GIF endpoint", async () => {
    fetch.mockResolvedValue(
      mockResponse({ data: [] })
    );

    const Api = await loadApi();

    await Api.searchGifs("cat");

    expect(fetch).toHaveBeenCalledTimes(1);

    const [url, options] = fetch.mock.calls[0];

    expect(url).toBe(
      "/api/gifs?animal=cat&offset=0"
    );

    expect(options.method).toBe("GET");
    expect(options.headers.Accept).toBe(
      "application/json"
    );
  });

  it("encodes multi-word animal names", async () => {
    fetch.mockResolvedValue(
      mockResponse({ data: [] })
    );

    const Api = await loadApi();

    await Api.searchGifs("red panda");

    expect(fetch.mock.calls[0][0]).toBe(
      "/api/gifs?animal=red+panda&offset=0"
    );
  });

  it("sends the requested offset", async () => {
    fetch.mockResolvedValue(
      mockResponse({ data: [] })
    );

    const Api = await loadApi();

    await Api.searchGifs("dog", 50);

    expect(fetch.mock.calls[0][0]).toBe(
      "/api/gifs?animal=dog&offset=50"
    );
  });

  it("returns valid GIFs", async () => {
    fetch.mockResolvedValue(
      mockResponse({
        data: [
          {
            id: "abc123",
            url: "https://media.giphy.com/cat.gif",
          },
        ],
      })
    );

    const Api = await loadApi();

    const result = await Api.searchGifs("cat");

    expect(result).toEqual([
      {
        id: "abc123",
        url: "https://media.giphy.com/cat.gif",
      },
    ]);
  });

  it("preserves and normalizes GIF dimensions", async () => {
    fetch.mockResolvedValue(
      mockResponse({
        data: [
          {
            id: "abc123",
            url: "https://media.giphy.com/cat.gif",
            width: "480",
            height: 270,
          },
        ],
      })
    );

    const Api = await loadApi();

    const result = await Api.searchGifs("cat");

    expect(result).toEqual([
      {
        id: "abc123",
        url: "https://media.giphy.com/cat.gif",
        width: 480,
        height: 270,
      },
    ]);
  });

  it("returns an empty array when data is missing", async () => {
    fetch.mockResolvedValue(
      mockResponse({})
    );

    const Api = await loadApi();

    await expect(
      Api.searchGifs("cat")
    ).resolves.toEqual([]);
  });

  it("filters malformed GIF records", async () => {
    fetch.mockResolvedValue(
      mockResponse({
        data: [
          null,
          {},
          {
            id: "missing-url",
          },
          {
            url: "https://example.com/no-id.gif",
          },
          {
            id: "valid",
            url: "https://example.com/valid.gif",
          },
        ],
      })
    );

    const Api = await loadApi();

    const result = await Api.searchGifs("cat");

    expect(result).toEqual([
      {
        id: "valid",
        url: "https://example.com/valid.gif",
      },
    ]);
  });

  it("rejects unsafe URLs", async () => {
    fetch.mockResolvedValue(
      mockResponse({
        data: [
          {
            id: "bad-1",
            url: "javascript:alert(1)",
          },
          {
            id: "bad-2",
            url: "data:text/html,test",
          },
          {
            id: "good",
            url: "https://example.com/good.gif",
          },
        ],
      })
    );

    const Api = await loadApi();

    const result = await Api.searchGifs("cat");

    expect(result).toEqual([
      {
        id: "good",
        url: "https://example.com/good.gif",
      },
    ]);
  });

  it("accepts HTTP and HTTPS URLs", async () => {
    fetch.mockResolvedValue(
      mockResponse({
        data: [
          {
            id: "http",
            url: "http://example.com/a.gif",
          },
          {
            id: "https",
            url: "https://example.com/b.gif",
          },
        ],
      })
    );

    const Api = await loadApi();

    const result = await Api.searchGifs("cat");

    expect(result).toHaveLength(2);
  });

  it("ignores invalid dimensions", async () => {
    fetch.mockResolvedValue(
      mockResponse({
        data: [
          {
            id: "gif",
            url: "https://example.com/gif.gif",
            width: -10,
            height: "not-a-number",
          },
        ],
      })
    );

    const Api = await loadApi();

    const result = await Api.searchGifs("cat");

    expect(result).toEqual([
      {
        id: "gif",
        url: "https://example.com/gif.gif",
      },
    ]);
  });

  it("throws the backend error", async () => {
    fetch.mockResolvedValue(
      mockResponse(
        {
          error: "Too many requests.",
        },
        {
          ok: false,
          status: 429,
        }
      )
    );

    const Api = await loadApi();

    await expect(
      Api.searchGifs("cat")
    ).rejects.toThrow(
      "Too many requests."
    );
  });

  it("uses HTTP status when no backend error exists", async () => {
    fetch.mockResolvedValue(
      mockResponse(
        {},
        {
          ok: false,
          status: 500,
        }
      )
    );

    const Api = await loadApi();

    await expect(
      Api.searchGifs("cat")
    ).rejects.toThrow(
      "Request failed (HTTP 500)."
    );
  });

  it("handles malformed JSON", async () => {
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(
        new Error("invalid JSON")
      ),
    });

    const Api = await loadApi();

    await expect(
      Api.searchGifs("cat")
    ).rejects.toThrow(
      "Unexpected server response. Start the Flask server."
    );
  });

  it("handles network failures", async () => {
    fetch.mockRejectedValue(
      new TypeError("Failed to fetch")
    );

    const Api = await loadApi();

    await expect(
      Api.searchGifs("cat")
    ).rejects.toThrow(
      "Could not reach the server. Is it running?"
    );
  });

  it("preserves AbortError", async () => {
    const error = new DOMException(
      "The operation was aborted.",
      "AbortError"
    );

    fetch.mockRejectedValue(error);

    const Api = await loadApi();

    await expect(
      Api.searchGifs("cat")
    ).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("passes AbortSignal to fetch", async () => {
    fetch.mockResolvedValue(
      mockResponse({ data: [] })
    );

    const Api = await loadApi();

    const controller =
      new AbortController();

    await Api.searchGifs(
      "cat",
      0,
      {
        signal: controller.signal,
      }
    );

    expect(
      fetch.mock.calls[0][1].signal
    ).toBe(controller.signal);
  });

  it("fails clearly when CONFIG is missing", async () => {
    delete globalThis.CONFIG;

    const Api = await loadApi();

    await expect(
      Api.searchGifs("cat")
    ).rejects.toThrow(
      "GIF API endpoint is not configured."
    );

    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails clearly when the endpoint is empty", async () => {
    globalThis.CONFIG = {
      GIFS_ENDPOINT: "",
    };

    const Api = await loadApi();

    await expect(
      Api.searchGifs("cat")
    ).rejects.toThrow(
      "GIF API endpoint is not configured."
    );
  });
});
