(() => {
  "use strict";

  // ============================================================
  // Configuration
  // ============================================================

  const POPULAR_ANIMALS = [
    "dog",
    "cat",
    "panda",
    "penguin",
    "otter",
    "capybara",
    "sloth",
    "red panda",
  ];

  const MAX_HISTORY = 30;
  const PREFETCH_THRESHOLD = 3;

  // Backend accepts letters, spaces and internal hyphens.
  const ANIMAL_PATTERN = /^[a-z]+(?:[ -][a-z]+)*$/i;

  // ============================================================
  // DOM
  // ============================================================

  const $ = (id) => document.getElementById(id);

  const inputStage = $("input-stage");
  const gifStage = $("gif-stage");

  const form = $("animal-form");
  const input = $("animal-input");
  const errorMsg = $("error-msg");

  const quickPicks = $("quick-picks");
  const surpriseBtn = $("surprise-btn");

  const currentAnimal = $("current-animal");
  const counter = $("counter");

  const gifFrame = $("gif-frame");
  const gifImage = $("gif-image");
  const loader = $("loader");

  const notice = $("notice");

  const nextBtn = $("next-btn");
  const resetBtn = $("reset-btn");

  const favBtn = $("fav-btn");
  const shareBtn = $("share-btn");
  const copyBtn = $("copy-btn");
  const openBtn = $("open-btn");

  const history = $("history");
  const historyStrip = $("history-strip");

  const favorites = $("favorites");
  const favCount = $("fav-count");
  const favClear = $("fav-clear");
  const favGrid = $("fav-grid");

  const toast = $("toast");

  // ============================================================
  // State
  // ============================================================

  let session = null;

  // Fast lookup of GIF IDs already shown.
  let shownIds = new Set();

  // GIFs currently available for this session.
  let pool = [];

  // GIF waiting to be shown immediately.
  let prefetchedGif = null;

  // Prevent overlapping "next GIF" operations.
  let isLoading = false;

  // Used to invalidate old async requests when changing animals.
  let requestController = null;

  // Used to prevent stale async responses from updating the UI.
  let requestGeneration = 0;

  // Current GIF.
  let currentGif = null;

  // Prevent duplicate toast timers.
  let toastTimer = null;

  // ============================================================
  // Utility
  // ============================================================

  function normalizeAnimal(value) {
    return String(value || "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  }

  function validateAnimal(value) {
    const animal = normalizeAnimal(value);

    if (!animal) {
      return {
        ok: false,
        error: "Please enter an animal name.",
      };
    }

    if (animal.length > 30) {
      return {
        ok: false,
        error: "Animal name is too long.",
      };
    }

    if (!ANIMAL_PATTERN.test(animal)) {
      return {
        ok: false,
        error:
          "Use letters, spaces, or a hyphen between animal words.",
      };
    }

    return {
      ok: true,
      value: animal,
    };
  }

  function setHidden(element, hidden) {
    if (!element) return;

    element.classList.toggle("hidden", hidden);
    element.hidden = hidden;
  }

  function setNotice(message = "") {
    notice.textContent = message;
  }

  function showError(message = "") {
    errorMsg.textContent = message;
  }

  function showToast(message) {
    if (!toast) return;

    toast.textContent = message;
    toast.classList.add("show");

    clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {
      toast.classList.remove("show");
    }, 2200);
  }

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = value;
    return div.innerHTML;
  }

  function getGifAlt(gif) {
    const animal = session?.animal || gif?.animal || "animal";
    return `Funny ${animal} GIF`;
  }

  // ============================================================
  // Stage management
  // ============================================================

  function showInputStage() {
    setHidden(inputStage, false);
    setHidden(gifStage, true);

    requestAnimationFrame(() => {
      input.focus();
    });
  }

  function showGifStage() {
    setHidden(inputStage, true);
    setHidden(gifStage, false);
  }

  // ============================================================
  // Quick picks
  // ============================================================

  function renderQuickPicks() {
    quickPicks.innerHTML = "";

    const fragment = document.createDocumentFragment();

    for (const animal of POPULAR_ANIMALS) {
      const button = document.createElement("button");

      button.type = "button";
      button.className = "chip";
      button.textContent = animal;

      button.addEventListener("click", () => {
        startAnimal(animal);
      });

      fragment.appendChild(button);
    }

    quickPicks.appendChild(fragment);
  }

  // ============================================================
  // API helpers
  // ============================================================

  async function searchGifs(animal, offset, signal) {
    /*
     * Prefer the project's Api module if available.
     *
     * This keeps the frontend compatible with the existing api.js.
     */
    if (typeof Api?.searchGifs === "function") {
      return Api.searchGifs(animal, offset, { signal });
    }

    // Fallback implementation.
    const params = new URLSearchParams({
      animal,
      offset: String(offset),
    });

    const response = await fetch(
      `/api/gifs?${params.toString()}`,
      {
        signal,
        headers: {
          Accept: "application/json",
        },
      }
    );

    let payload;

    try {
      payload = await response.json();
    } catch {
      throw new Error("Invalid response from the GIF service.");
    }

    if (!response.ok) {
      throw new Error(
        payload?.error ||
          "Could not load GIFs. Please try again."
      );
    }

    return Array.isArray(payload?.data)
      ? payload.data
      : [];
  }

  // ============================================================
  // GIF normalization
  // ============================================================

  function normalizeGif(gif) {
    if (!gif || !gif.id || !gif.url) {
      return null;
    }

    return {
      id: String(gif.id),
      url: String(gif.url),
      width: gif.width
        ? Number(gif.width)
        : undefined,
      height: gif.height
        ? Number(gif.height)
        : undefined,
      animal: session?.animal || "",
    };
  }

  function addToPool(gifs) {
    if (!Array.isArray(gifs)) return;

    for (const rawGif of gifs) {
      const gif = normalizeGif(rawGif);

      if (!gif) continue;

      if (shownIds.has(gif.id)) continue;

      if (
        pool.some((existing) => existing.id === gif.id)
      ) {
        continue;
      }

      pool.push(gif);
    }
  }

  // ============================================================
  // API loading
  // ============================================================

  async function fetchMoreGifs() {
    if (!session) return [];

    const generation = requestGeneration;

    if (requestController) {
      requestController.abort();
    }

    requestController = new AbortController();

    try {
      const gifs = await searchGifs(
        session.animal,
        session.offset,
        requestController.signal
      );

      // Ignore responses belonging to an old session.
      if (generation !== requestGeneration) {
        return [];
      }

      const normalized = [];

      for (const rawGif of gifs || []) {
        const gif = normalizeGif(rawGif);

        if (!gif) continue;

        normalized.push(gif);
      }

      // Advance pagination only after a successful response.
      session.offset += normalized.length || 25;

      addToPool(normalized);

      saveSession();

      return normalized;
    } catch (error) {
      if (error?.name === "AbortError") {
        return [];
      }

      throw error;
    } finally {
      requestController = null;
    }
  }

  // ============================================================
  // Session persistence
  // ============================================================

  function saveSession() {
    if (!session) return;

    /*
     * Storage modules generally expect shownIds to be serializable.
     */
    session.shownIds = [...shownIds];

    if (typeof Storage?.save === "function") {
      Storage.save(session);
    }
  }

  function createSession(animal) {
    if (typeof Storage?.start === "function") {
      session = Storage.start(animal);
    } else {
      session = {
        animal,
        shownIds: [],
        offset: 0,
      };
    }

    session.animal = animal;
    session.shownIds = Array.isArray(session.shownIds)
      ? session.shownIds
      : [];

    session.offset = Number.isFinite(
      Number(session.offset)
    )
      ? Number(session.offset)
      : 0;

    shownIds = new Set(session.shownIds);

    pool = [];
    prefetchedGif = null;
    currentGif = null;
  }

  function loadSavedSession() {
    if (typeof Storage?.load !== "function") {
      return null;
    }

    const saved = Storage.load();

    if (!saved?.animal) {
      return null;
    }

    const validation = validateAnimal(saved.animal);

    if (!validation.ok) {
      return null;
    }

    session = {
      ...saved,
      animal: validation.value,
      shownIds: Array.isArray(saved.shownIds)
        ? saved.shownIds
        : [],
      offset: Number.isFinite(Number(saved.offset))
        ? Number(saved.offset)
        : 0,
    };

    shownIds = new Set(session.shownIds);

    pool = [];
    prefetchedGif = null;
    currentGif = null;

    return session;
  }

  // ============================================================
  // GIF selection
  // ============================================================

  function nextUnseenGif() {
    const index = pool.findIndex(
      (gif) => !shownIds.has(gif.id)
    );

    if (index === -1) {
      return null;
    }

    return pool.splice(index, 1)[0];
  }

  // ============================================================
  // GIF rendering
  // ============================================================

  function showGif(gif) {
    if (!gif) return;

    currentGif = gif;

    gifImage.src = gif.url;
    gifImage.alt = getGifAlt(gif);

    /*
     * Reserve space when the backend supplies dimensions.
     * This reduces layout shift while the GIF loads.
     */
    if (
      Number.isFinite(gif.width) &&
      Number.isFinite(gif.height) &&
      gif.width > 0 &&
      gif.height > 0
    ) {
      gifImage.width = gif.width;
      gifImage.height = gif.height;

      gifFrame.style.aspectRatio =
        `${gif.width} / ${gif.height}`;
    } else {
      gifImage.removeAttribute("width");
      gifImage.removeAttribute("height");
      gifFrame.style.removeProperty("aspect-ratio");
    }

    shownIds.add(gif.id);

    renderCounter();
    renderFavoriteButton();
    addHistory(gif);

    saveSession();

    prefetchIfNeeded();

    setHidden(loader, true);
  }

  function renderCounter() {
    counter.textContent =
      `${shownIds.size} viewed`;
  }

  function renderFavoriteButton() {
    if (!currentGif) {
      favBtn.textContent = "♡";
      favBtn.setAttribute("aria-pressed", "false");
      return;
    }

    const isFavorite =
      typeof Favorites?.has === "function" &&
      Favorites.has(currentGif.id);

    favBtn.textContent = isFavorite ? "♥" : "♡";

    favBtn.setAttribute(
      "aria-pressed",
      String(Boolean(isFavorite))
    );

    favBtn.title = isFavorite
      ? "Remove from favorites"
      : "Save to favorites";
  }

  // ============================================================
  // History
  // ============================================================

  function addHistory(gif) {
    if (!gif) return;

    let items = [...historyStrip.querySelectorAll(".thumb")];

    const existing = items.find(
      (element) =>
        element.dataset.gifId === gif.id
    );

    if (existing) {
      existing.remove();
    }

    const button = createThumbnail(gif);

    historyStrip.prepend(button);

    items = [...historyStrip.querySelectorAll(".thumb")];

    if (items.length > MAX_HISTORY) {
      items
        .slice(MAX_HISTORY)
        .forEach((item) => item.remove());
    }

    setHidden(history, false);
  }

  function createThumbnail(gif) {
    const button = document.createElement("button");

    button.type = "button";
    button.className = "thumb";
    button.dataset.gifId = gif.id;
    button.title = "View this GIF";

    const image = document.createElement("img");

    image.src = gif.url;
    image.alt = getGifAlt(gif);
    image.loading = "lazy";
    image.decoding = "async";

    button.appendChild(image);

    button.addEventListener("click", () => {
      if (shownIds.has(gif.id)) {
        /*
         * History items are already viewed, so displaying them again
         * should not increment the counter.
         */
        currentGif = gif;
        gifImage.src = gif.url;
        gifImage.alt = getGifAlt(gif);

        renderFavoriteButton();
      }
    });

    return button;
  }

  // ============================================================
  // Favorites
  // ============================================================

  function renderFavorites() {
    if (
      typeof Favorites?.load !== "function"
    ) {
      return;
    }

    const items = Favorites.load() || [];

    favGrid.innerHTML = "";

    const fragment = document.createDocumentFragment();

    for (const gif of items) {
      const button = createFavoriteThumbnail(gif);
      fragment.appendChild(button);
    }

    favGrid.appendChild(fragment);

    favCount.textContent = String(items.length);

    setHidden(
      favorites,
      items.length === 0
    );
  }

  function createFavoriteThumbnail(gif) {
    const wrapper = document.createElement("div");

    wrapper.className = "fav-item";

    const button = document.createElement("button");

    button.type = "button";
    button.className = "thumb";
    button.title = "View favorite";

    const image = document.createElement("img");

    image.src = gif.url;
    image.alt = getGifAlt(gif);
    image.loading = "lazy";
    image.decoding = "async";

    button.appendChild(image);

    button.addEventListener("click", () => {
      currentGif = gif;

      gifImage.src = gif.url;
      gifImage.alt = getGifAlt(gif);

      renderFavoriteButton();
    });

    wrapper.appendChild(button);

    return wrapper;
  }

  // ============================================================
  // Prefetch
  // ============================================================

  async function prefetchIfNeeded() {
    if (!session) return;

    if (prefetchedGif) return;

    if (pool.length >= PREFETCH_THRESHOLD) {
      return;
    }

    try {
      await fetchMoreGifs();

      if (!prefetchedGif) {
        prefetchedGif = nextUnseenGif();
      }
    } catch {
      /*
       * Prefetch errors are deliberately silent.
       *
       * The user only sees an error if an actual "Next GIF" operation
       * needs the network and fails.
       */
    }
  }

  // ============================================================
  // Next GIF
  // ============================================================

  async function nextGif() {
    if (!session || isLoading) {
      return;
    }

    isLoading = true;
    nextBtn.disabled = true;

    setHidden(loader, false);
    setNotice("");

    try {
      let gif = null;

      if (prefetchedGif) {
        gif = prefetchedGif;
        prefetchedGif = null;
      }

      if (!gif) {
        gif = nextUnseenGif();
      }

      /*
       * If we don't have anything locally, fetch more.
       */
      if (!gif) {
        await fetchMoreGifs();

        gif = nextUnseenGif();
      }

      /*
       * We may have received only duplicates from the API.
       * Try one additional page before giving up.
       */
      if (!gif) {
        await fetchMoreGifs();

        gif = nextUnseenGif();
      }

      if (!gif) {
        setNotice(
          `No more funny ${session.animal} GIFs found right now.`
        );
        return;
      }

      showGif(gif);
    } catch (error) {
      if (error?.name === "AbortError") {
        return;
      }

      console.error(error);

      setNotice(
        error?.message ||
          "Could not load a GIF. Please try again."
      );
    } finally {
      isLoading = false;
      nextBtn.disabled = false;
      setHidden(loader, true);
    }
  }

  // ============================================================
  // Start animal
  // ============================================================

  async function startAnimal(rawAnimal) {
    const validation = validateAnimal(rawAnimal);

    showError("");
    setNotice("");

    if (!validation.ok) {
      showError(validation.error);
      input.focus();
      return;
    }

    /*
     * Invalidate every outstanding request from the previous session.
     */
    requestGeneration += 1;

    if (requestController) {
      requestController.abort();
      requestController = null;
    }

    isLoading = false;

    createSession(validation.value);

    currentAnimal.textContent = session.animal;

    showGifStage();

    renderCounter();
    renderFavorites();

    await nextGif();
  }

  // ============================================================
  // Reset
  // ============================================================

  function reset() {
    requestGeneration += 1;

    if (requestController) {
      requestController.abort();
      requestController = null;
    }

    isLoading = false;

    if (typeof Storage?.clear === "function") {
      Storage.clear();
    }

    session = null;
    shownIds = new Set();
    pool = [];
    prefetchedGif = null;
    currentGif = null;

    gifImage.removeAttribute("src");
    gifImage.alt = "";

    setNotice("");
    showError("");

    input.value = "";

    showInputStage();
  }

  // ============================================================
  // Favorites actions
  // ============================================================

  function toggleFavorite() {
    if (!currentGif) return;

    if (
      typeof Favorites?.has !== "function" ||
      typeof Favorites?.add !== "function" ||
      typeof Favorites?.remove !== "function"
    ) {
      return;
    }

    if (Favorites.has(currentGif.id)) {
      Favorites.remove(currentGif.id);
      showToast("Removed from favorites.");
    } else {
      Favorites.add(currentGif);
      showToast("Saved to favorites.");
    }

    renderFavoriteButton();
    renderFavorites();
  }

  function clearFavorites() {
    if (
      typeof Favorites?.clear !== "function"
    ) {
      return;
    }

    Favorites.clear();

    renderFavoriteButton();
    renderFavorites();

    showToast("Favorites cleared.");
  }

  // ============================================================
  // Share / copy / open
  // ============================================================

  async function copyGifLink() {
    if (!currentGif?.url) return;

    try {
      await navigator.clipboard.writeText(
        currentGif.url
      );

      showToast("GIF link copied.");
    } catch {
      showToast("Could not copy the GIF link.");
    }
  }

  async function shareGif() {
    if (!currentGif?.url) return;

    const shareData = {
      title: `Funny ${session?.animal || "animal"} GIF`,
      url: currentGif.url,
    };

    if (
      typeof navigator.share === "function"
    ) {
      try {
        await navigator.share(shareData);
      } catch (error) {
        /*
         * AbortError means the user simply cancelled sharing.
         */
        if (error?.name !== "AbortError") {
          showToast("Could not share the GIF.");
        }
      }

      return;
    }

    await copyGifLink();
  }

  function openGif() {
    if (!currentGif?.url) return;

    window.open(
      currentGif.url,
      "_blank",
      "noopener,noreferrer"
    );
  }

  // ============================================================
  // Keyboard shortcuts
  // ============================================================

  function isTypingTarget(element) {
    if (!element) return false;

    const tag = element.tagName?.toLowerCase();

    return (
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      element.isContentEditable
    );
  }

  function handleKeyboard(event) {
    if (isTypingTarget(event.target)) {
      return;
    }

    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }

    switch (event.code) {
      case "Space":
      case "ArrowRight":
        if (!gifStage.hidden) {
          event.preventDefault();
          nextGif();
        }
        break;

      case "KeyF":
        if (!gifStage.hidden) {
          event.preventDefault();
          toggleFavorite();
        }
        break;

      case "Escape":
        if (!gifStage.hidden) {
          event.preventDefault();
          reset();
        }
        break;

      default:
        break;
    }
  }

  // ============================================================
  // Events
  // ============================================================

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    startAnimal(input.value);
  });

  surpriseBtn.addEventListener("click", () => {
    const animal =
      POPULAR_ANIMALS[
        Math.floor(
          Math.random() * POPULAR_ANIMALS.length
        )
      ];

    startAnimal(animal);
  });

  nextBtn.addEventListener("click", () => {
    nextGif();
  });

  resetBtn.addEventListener("click", () => {
    reset();
  });

  favBtn.addEventListener("click", () => {
    toggleFavorite();
  });

  favClear.addEventListener("click", () => {
    clearFavorites();
  });

  shareBtn.addEventListener("click", () => {
    shareGif();
  });

  copyBtn.addEventListener("click", () => {
    copyGifLink();
  });

  openBtn.addEventListener("click", () => {
    openGif();
  });

  document.addEventListener(
    "keydown",
    handleKeyboard
  );

  // ============================================================
  // Image loading
  // ============================================================

  gifImage.addEventListener("load", () => {
    setHidden(loader, true);
  });

  gifImage.addEventListener("error", () => {
    setHidden(loader, true);

    setNotice(
      "This GIF could not be displayed. Try the next one."
    );
  });

  // ============================================================
  // Initialization
  // ============================================================

  function init() {
    renderQuickPicks();
    renderFavorites();

    const saved = loadSavedSession();

    if (saved) {
      currentAnimal.textContent = saved.animal;

      showGifStage();
      renderCounter();

      /*
       * Resume the previous session by loading more GIFs.
       */
      nextGif().catch((error) => {
        console.error(error);

        setNotice(
          "Could not resume your previous GIF session."
        );
      });
    } else {
      showInputStage();
    }
  }

  init();
})();
