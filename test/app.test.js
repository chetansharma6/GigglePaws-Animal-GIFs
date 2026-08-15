import {
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const HTML = `
<!DOCTYPE html>
<html>
<body>

<div id="input-stage">
  <form id="animal-form">
    <input id="animal-input" />
    <button id="start-btn" type="submit">Generate</button>
    <p id="error-msg"></p>
  </form>

  <div id="quick-picks"></div>

  <button id="surprise-btn" type="button">
    Surprise
  </button>
</div>

<div id="gif-stage" class="hidden">

  <span id="current-animal"></span>
  <span id="counter"></span>

  <div id="gif-frame">
    <div id="loader" class="hidden"></div>

    <img id="gif-image" />

    <button id="fav-btn" type="button">♡</button>
    <button id="share-btn" type="button">Share</button>
    <button id="copy-btn" type="button">Copy</button>
    <button id="open-btn" type="button">Open</button>
  </div>

  <p id="notice"></p>

  <button id="next-btn" type="button">
    Next
  </button>

  <button id="reset-btn" type="button">
    Reset
  </button>

  <div id="history" class="hidden">
    <div id="history-strip"></div>
  </div>

  <div id="favorites" class="hidden">
    <span id="fav-count">0</span>
    <button id="fav-clear" type="button">
      Clear
    </button>
    <div id="fav-grid"></div>
  </div>

</div>

<div id="toast"></div>

</body>
</html>
`;

describe("Animal GIFs app", () => {
  let searchGifs;
  let storage;
  let favorites;

  beforeEach(async () => {
    vi.resetModules();

    document.body.innerHTML = HTML;

    searchGifs = vi.fn();

    storage = {
      load: vi.fn(() => null),
      save: vi.fn(),
      start: vi.fn((animal) => ({
        animal,
        offset: 0,
        shownIds: [],
      })),
      clear: vi.fn(),
    };

    favorites = {
      items: [],
      load: vi.fn(() => favorites.items),
      has: vi.fn(
        (id) =>
          favorites.items.some(
            (gif) => gif.id === id
          )
      ),
      add: vi.fn((gif) => {
        if (
          !favorites.items.some(
            (item) => item.id === gif.id
          )
        ) {
          favorites.items.push(gif);
        }
      }),
      remove: vi.fn((id) => {
        favorites.items =
          favorites.items.filter(
            (gif) => gif.id !== id
          );
      }),
      clear: vi.fn(() => {
        favorites.items = [];
      }),
    };

    globalThis.CONFIG = {
      GIFS_ENDPOINT: "/api/gifs",
    };

    globalThis.Api = {
      searchGifs,
    };

    globalThis.Storage = storage;

    globalThis.Favorites = favorites;

    searchGifs.mockResolvedValue([
      {
        id: "gif-1",
        url: "https://example.com/gif-1.gif",
        width: 480,
        height: 270,
      },
      {
        id: "gif-2",
        url: "https://example.com/gif-2.gif",
        width: 480,
        height: 270,
      },
      {
        id: "gif-3",
        url: "https://example.com/gif-3.gif",
        width: 480,
        height: 270,
      },
    ]);

    await import("../app.js");

    /*
     * Allow the initial async work in init() to finish.
     */
    await new Promise((resolve) =>
      setTimeout(resolve, 0)
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();

    delete globalThis.Api;
    delete globalThis.Storage;
    delete globalThis.Favorites;
    delete globalThis.CONFIG;
  });

  it("renders popular animal buttons", () => {
    const buttons =
      document.querySelectorAll(
        "#quick-picks button"
      );

    expect(buttons.length).toBeGreaterThan(0);
  });

  it("starts with the input stage visible", () => {
    const inputStage =
      document.getElementById("input-stage");

    const gifStage =
      document.getElementById("gif-stage");

    expect(
      inputStage.classList.contains("hidden")
    ).toBe(false);

    expect(
      gifStage.classList.contains("hidden")
    ).toBe(true);
  });

  it("starts a GIF session when an animal is submitted", async () => {
    const input =
      document.getElementById("animal-input");

    const form =
      document.getElementById("animal-form");

    input.value = "cat";

    form.dispatchEvent(
      new Event("submit", {
        bubbles: true,
        cancelable: true,
      })
    );

    await new Promise((resolve) =>
      setTimeout(resolve, 0)
    );

    expect(storage.start).toHaveBeenCalledWith(
      "cat"
    );

    expect(searchGifs).toHaveBeenCalled();

    expect(
      document.getElementById(
        "current-animal"
      ).textContent
    ).toBe("cat");
  });

  it("accepts multi-word animals", async () => {
    const input =
      document.getElementById("animal-input");

    const form =
      document.getElementById("animal-form");

    input.value = "red panda";

    form.dispatchEvent(
      new Event("submit", {
        bubbles: true,
        cancelable: true,
      })
    );

    await new Promise((resolve) =>
      setTimeout(resolve, 0)
    );

    expect(storage.start).toHaveBeenCalledWith(
      "red panda"
    );
  });

  it("normalizes extra spaces", async () => {
    const input =
      document.getElementById("animal-input");

    const form =
      document.getElementById("animal-form");

    input.value = "   red    panda   ";

    form.dispatchEvent(
      new Event("submit", {
        bubbles: true,
        cancelable: true,
      })
    );

    await new Promise((resolve) =>
      setTimeout(resolve, 0)
    );

    expect(storage.start).toHaveBeenCalledWith(
      "red panda"
    );
  });

  it("rejects empty animal names", async () => {
    const input =
      document.getElementById("animal-input");

    const form =
      document.getElementById("animal-form");

    input.value = "";

    form.dispatchEvent(
      new Event("submit", {
        bubbles: true,
        cancelable: true,
      })
    );

    await new Promise((resolve) =>
      setTimeout(resolve, 0)
    );

    expect(
      document.getElementById(
        "error-msg"
      ).textContent
    ).toContain("Please enter an animal name.");

    expect(storage.start).not.toHaveBeenCalled();
  });

  it("rejects invalid characters", async () => {
    const input =
      document.getElementById("animal-input");

    const form =
      document.getElementById("animal-form");

    input.value = "cat!";

    form.dispatchEvent(
      new Event("submit", {
        bubbles: true,
        cancelable: true,
      })
    );

    await new Promise((resolve) =>
      setTimeout(resolve, 0)
    );

    expect(
      document.getElementById(
        "error-msg"
      ).textContent
    ).toContain("Use letters");
  });

  it("displays the GIF returned by the API", async () => {
    const image =
      document.getElementById("gif-image");

    expect(image.src).toBe(
      "https://example.com/gif-1.gif"
    );

    expect(image.alt).toContain(
      "Funny"
    );
  });

  it("uses GIF dimensions", () => {
    const image =
      document.getElementById("gif-image");

    expect(image.width).toBe(480);
    expect(image.height).toBe(270);
  });

  it("updates the viewed counter", () => {
    const counter =
      document.getElementById("counter");

    expect(counter.textContent).toBe(
      "1 viewed"
    );
  });

  it("saves the session", () => {
    expect(storage.save).toHaveBeenCalled();
  });

  it("loads the next GIF", async () => {
    const next =
      document.getElementById("next-btn");

    next.click();

    await new Promise((resolve) =>
      setTimeout(resolve, 0)
    );

    expect(
      document.getElementById(
        "gif-image"
      ).src
    ).toBe(
      "https://example.com/gif-2.gif"
    );
  });

  it("does not display the same GIF twice", async () => {
    const next =
      document.getElementById("next-btn");

    next.click();

    await new Promise((resolve) =>
      setTimeout(resolve, 0)
    );

    expect(
      document.getElementById(
        "gif-image"
      ).src
    ).toBe(
      "https://example.com/gif-2.gif"
    );

    next.click();

    await new Promise((resolve) =>
      setTimeout(resolve, 0)
    );

    expect(
      document.getElementById(
        "gif-image"
      ).src
    ).toBe(
      "https://example.com/gif-3.gif"
    );
  });

  it("adds viewed GIFs to history", () => {
    const history =
      document.getElementById("history");

    const thumbnails =
      document.querySelectorAll(
        "#history-strip .thumb"
      );

    expect(
      history.classList.contains("hidden")
    ).toBe(false);

    expect(thumbnails.length).toBe(1);
  });

  it("adds the current GIF to favorites", () => {
    const favorite =
      document.getElementById("fav-btn");

    favorite.click();

    expect(
      favorites.add
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "gif-1",
      })
    );

    expect(
      favorite.getAttribute(
        "aria-pressed"
      )
    ).toBe("true");
  });

  it("removes a GIF from favorites", () => {
    const favorite =
      document.getElementById("fav-btn");

    favorite.click();
    favorite.click();

    expect(
      favorites.remove
    ).toHaveBeenCalledWith("gif-1");
  });

  it("clears all favorites", () => {
    const favorite =
      document.getElementById("fav-btn");

    favorite.click();

    const clear =
      document.getElementById("fav-clear");

    clear.click();

    expect(
      favorites.clear
    ).toHaveBeenCalled();
  });

  it("renders favorites", () => {
    favorites.items = [
      {
        id: "favorite-1",
        url: "https://example.com/favorite.gif",
      },
    ];

    /*
     * Trigger the favorite button so the application refreshes
     * its favorites UI.
     */
    document
      .getElementById("fav-btn")
      .click();

    expect(
      document.querySelector(
        "#fav-grid .thumb"
      )
    ).not.toBeNull();
  });

  it("resets the application", () => {
    const reset =
      document.getElementById("reset-btn");

    reset.click();

    expect(
      storage.clear
    ).toHaveBeenCalled();

    expect(
      document.getElementById(
        "input-stage"
      ).classList.contains("hidden")
    ).toBe(false);

    expect(
      document.getElementById(
        "gif-stage"
      ).classList.contains("hidden")
    ).toBe(true);
  });

  it("supports the F keyboard shortcut", () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "KeyF",
        bubbles: true,
      })
    );

    expect(
      favorites.add
    ).toHaveBeenCalled();
  });

  it("supports the Escape keyboard shortcut", () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "Escape",
        bubbles: true,
      })
    );

    expect(
      storage.clear
    ).toHaveBeenCalled();
  });

  it("does not use keyboard shortcuts while typing", () => {
    const input =
      document.getElementById("animal-input");

    input.focus();

    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "F",
        bubbles: true,
      })
    );

    expect(
      favorites.add
    ).not.toHaveBeenCalled();
  });

  it("shows API errors", async () => {
    searchGifs.mockRejectedValueOnce(
      new Error("GIF service unavailable")
    );

    const input =
      document.getElementById("animal-input");

    const form =
      document.getElementById("animal-form");

    input.value = "koala";

    form.dispatchEvent(
      new Event("submit", {
        bubbles: true,
        cancelable: true,
      })
    );

    await new Promise((resolve) =>
      setTimeout(resolve, 0)
    );

    expect(
      document.getElementById(
        "notice"
      ).textContent
    ).toContain(
      "GIF service unavailable"
    );
  });

  it("does not crash when the API returns no GIFs", async () => {
    searchGifs.mockResolvedValueOnce([]);

    const input =
      document.getElementById("animal-input");

    const form =
      document.getElementById("animal-form");

    input.value = "axolotl";

    form.dispatchEvent(
      new Event("submit", {
        bubbles: true,
        cancelable: true,
      })
    );

    await new Promise((resolve) =>
      setTimeout(resolve, 0)
    );

    expect(
      document.getElementById(
        "notice"
      ).textContent
    ).toContain(
      "No more funny axolotl GIFs"
    );
  });
});
