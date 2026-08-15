```python
"""
server.py — Flask backend for Animal GIFs.

Responsibilities:
  * Serve the static frontend.
  * Proxy GIF searches to GIPHY so the API key stays server-side.
  * Validate and rate-limit API requests.
  * Cache recent GIPHY searches to reduce API usage and latency.
  * Add security-related HTTP headers.

Run locally:
    pip install -r requirements.txt
    python server.py

Then open:
    http://127.0.0.1:5000

Production:
    Use a production WSGI server such as Gunicorn.
"""

from __future__ import annotations

import os
import re
import time
from typing import Any

import requests
from dotenv import load_dotenv
from flask import Flask, abort, jsonify, request, send_from_directory
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from werkzeug.middleware.proxy_fix import ProxyFix


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

load_dotenv()

GIPHY_API_KEY = os.getenv("GIPHY_API_KEY")
GIPHY_SEARCH_URL = "https://api.giphy.com/v1/gifs/search"

SEARCH_PREFIX = "funny"

# Number of GIFs requested from GIPHY per API call.
FETCH_LIMIT = 25

# GIPHY content rating.
RATING = "g"

# Request limits.
DEFAULT_RATE_LIMIT = os.getenv(
    "DEFAULT_RATE_LIMIT",
    "120 per minute",
)

GIF_RATE_LIMIT = os.getenv(
    "GIF_RATE_LIMIT",
    "40 per minute",
)

# Cache configuration.
CACHE_TTL_SECONDS = int(
    os.getenv("CACHE_TTL_SECONDS", "60")
)

CACHE_MAX_ENTRIES = int(
    os.getenv("CACHE_MAX_ENTRIES", "200")
)

# HTTP timeouts:
#   connection timeout = 3 seconds
#   read timeout       = 10 seconds
GIPHY_TIMEOUT = (3, 10)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

# Allows:
#   dog
#   red-panda
#   red panda
#   sea turtle
#   blue whale
#
# Rejects:
#   dog!
#   cat123
#   <script>
#   foo/bar
#
# Length is separately limited to 30 characters.
ANIMAL_PATTERN = re.compile(
    r"^[a-z]+(?:[ -][a-z]+)*$"
)


# ---------------------------------------------------------------------------
# Public files
# ---------------------------------------------------------------------------

# Only these frontend files can be served directly.
#
# This prevents accidental exposure of:
#   .env
#   server.py
#   requirements.txt
#   .git/
#   other project files
PUBLIC_FILES = frozenset(
    {
        "index.html",
        "styles.css",
        "app.js",
        "config.js",
        "storage.js",
        "api.js",
    }
)


# ---------------------------------------------------------------------------
# Flask application
# ---------------------------------------------------------------------------

app = Flask(
    __name__,
    static_folder=None,
)


# Render and similar hosts typically put one trusted reverse proxy in front
# of Flask. Only trust one proxy hop.
app.wsgi_app = ProxyFix(
    app.wsgi_app,
    x_for=1,
    x_proto=1,
    x_host=1,
)


# ---------------------------------------------------------------------------
# Rate limiting
# ---------------------------------------------------------------------------

limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=[DEFAULT_RATE_LIMIT],
    storage_uri="memory://",
)


@app.errorhandler(429)
def ratelimit_handler(_exc):
    """Return rate-limit errors as JSON."""
    return (
        jsonify(
            {
                "error": (
                    "Too many requests — "
                    "please slow down and try again."
                )
            }
        ),
        429,
    )


# ---------------------------------------------------------------------------
# HTTP client
# ---------------------------------------------------------------------------

# Reuse TCP connections to GIPHY instead of creating a new connection for
# every request.
http = requests.Session()

http.headers.update(
    {
        "User-Agent": "AnimalGIFs/1.0",
        "Accept": "application/json",
    }
)


# ---------------------------------------------------------------------------
# Simple in-memory TTL cache
# ---------------------------------------------------------------------------

# Structure:
#
# {
#     ("cat", 0): {
#         "expires": 1234567890.0,
#         "data": [...]
#     }
# }
#
# This is intentionally simple and works well for a small single-instance
# deployment.
#
# If the application is later scaled to multiple instances, replace this
# with Redis or another shared cache.
cache: dict[
    tuple[str, int],
    dict[str, Any],
] = {}


def get_cached(
    animal: str,
    offset: int,
) -> list[dict[str, str]] | None:
    """Return cached GIF data if it is still valid."""

    key = (animal, offset)
    entry = cache.get(key)

    if entry is None:
        return None

    if time.monotonic() >= entry["expires"]:
        cache.pop(key, None)
        return None

    return entry["data"]


def set_cached(
    animal: str,
    offset: int,
    data: list[dict[str, str]],
) -> None:
    """Store GIF data in the in-memory cache."""

    # Remove expired entries occasionally.
    now = time.monotonic()

    expired_keys = [
        key
        for key, entry in cache.items()
        if now >= entry["expires"]
    ]

    for key in expired_keys:
        cache.pop(key, None)

    # Prevent unlimited cache growth.
    if len(cache) >= CACHE_MAX_ENTRIES:
        oldest_key = next(iter(cache), None)

        if oldest_key is not None:
            cache.pop(oldest_key, None)

    cache[(animal, offset)] = {
        "expires": now + CACHE_TTL_SECONDS,
        "data": data,
    }


# ---------------------------------------------------------------------------
# Frontend routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    """Serve the frontend entry point."""
    return send_from_directory(
        BASE_DIR,
        "index.html",
    )


@app.route("/<path:filename>")
def frontend_file(filename: str):
    """
    Serve only explicitly allowlisted frontend files.

    Anything else returns 404.
    """

    if filename not in PUBLIC_FILES:
        abort(404)

    return send_from_directory(
        BASE_DIR,
        filename,
    )


# ---------------------------------------------------------------------------
# Security headers
# ---------------------------------------------------------------------------

CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' https://fonts.googleapis.com; "
    "font-src https://fonts.gstatic.com; "
    "img-src 'self' https://*.giphy.com https://giphy.com; "
    "connect-src 'self'; "
    "base-uri 'self'; "
    "form-action 'self'; "
    "object-src 'none'; "
    "frame-ancestors 'none'; "
    "upgrade-insecure-requests"
)


@app.after_request
def set_security_headers(response):
    """Add defensive security headers to every response."""

    response.headers["Content-Security-Policy"] = CSP

    response.headers["X-Content-Type-Options"] = "nosniff"

    response.headers["X-Frame-Options"] = "DENY"

    response.headers["Referrer-Policy"] = "no-referrer"

    response.headers["Permissions-Policy"] = (
        "geolocation=(), "
        "microphone=(), "
        "camera=()"
    )

    # Only send HSTS when the request actually arrived over HTTPS.
    #
    # This avoids forcing HTTPS on local development.
    if request.is_secure:
        response.headers["Strict-Transport-Security"] = (
            "max-age=31536000; includeSubDomains"
        )

    # Don't expose Flask/Werkzeug version information.
    response.headers["Server"] = "animal-gifs"

    return response


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def validate_animal(raw_animal: str | None) -> str | None:
    """
    Validate and normalize an animal search term.

    Returns:
        Normalized animal name, or None if invalid.
    """

    animal = (raw_animal or "").strip().lower()

    if not animal:
        return None

    if len(animal) > 30:
        return None

    if not ANIMAL_PATTERN.fullmatch(animal):
        return None

    return animal


def parse_offset(raw_offset: str | None) -> int | None:
    """
    Validate the pagination offset.

    GIPHY currently limits offsets to 4999.
    """

    value = raw_offset or "0"

    try:
        offset = int(value)
    except (TypeError, ValueError):
        return None

    if not 0 <= offset <= 4999:
        return None

    return offset


def select_gif_url(images: dict[str, Any]) -> str | None:
    """
    Select a reasonably sized GIF rendition.

    Avoid using the original GIF unless no smaller rendition exists,
    because original files can be very large.
    """

    preferred_variants = (
        "downsized_medium",
        "downsized",
        "fixed_width",
        "fixed_height",
        "original",
    )

    for variant in preferred_variants:
        image = images.get(variant)

        if not isinstance(image, dict):
            continue

        url = image.get("url")

        if isinstance(url, str) and url:
            return url

    return None


def extract_gifs(payload: Any) -> list[dict[str, str]]:
    """
    Extract only the fields required by the frontend from a GIPHY response.
    """

    if not isinstance(payload, dict):
        return []

    raw_data = payload.get("data")

    if not isinstance(raw_data, list):
        return []

    gifs: list[dict[str, str]] = []

    for gif in raw_data:
        if not isinstance(gif, dict):
            continue

        gif_id = gif.get("id")

        if not isinstance(gif_id, str) or not gif_id:
            continue

        images = gif.get("images")

        if not isinstance(images, dict):
            continue

        url = select_gif_url(images)

        if not url:
            continue

        # Include dimensions when available. The frontend can use these
        # to reserve space and reduce layout shift.
        selected_image = None

        for variant in (
            "downsized_medium",
            "downsized",
            "fixed_width",
            "fixed_height",
            "original",
        ):
            image = images.get(variant)

            if isinstance(image, dict) and image.get("url") == url:
                selected_image = image
                break

        result: dict[str, str] = {
            "id": gif_id,
            "url": url,
        }

        if selected_image:
            width = selected_image.get("width")
            height = selected_image.get("height")

            if width:
                result["width"] = str(width)

            if height:
                result["height"] = str(height)

        gifs.append(result)

    return gifs


# ---------------------------------------------------------------------------
# GIPHY API
# ---------------------------------------------------------------------------

@app.route("/api/gifs")
@limiter.limit(GIF_RATE_LIMIT)
def gifs():
    """
    Search GIPHY for funny GIFs of an animal.

    Query parameters:

        animal=<animal>
            Example:
                animal=red panda

        offset=<integer>
            Optional pagination offset, 0-4999.

    Returns:

        {
            "data": [
                {
                    "id": "...",
                    "url": "...",
                    "width": "...",
                    "height": "..."
                }
            ]
        }
    """

    # -----------------------------------------------------------------------
    # API key
    # -----------------------------------------------------------------------

    if not GIPHY_API_KEY:
        app.logger.error(
            "GIPHY_API_KEY is not configured."
        )

        return (
            jsonify(
                {
                    "error": (
                        "GIF service is not configured."
                    )
                }
            ),
            500,
        )

    # -----------------------------------------------------------------------
    # Animal validation
    # -----------------------------------------------------------------------

    animal = validate_animal(
        request.args.get("animal")
    )

    if animal is None:
        return (
            jsonify(
                {
                    "error": (
                        "Provide a valid animal name."
                    )
                }
            ),
            400,
        )

    # -----------------------------------------------------------------------
    # Offset validation
    # -----------------------------------------------------------------------

    offset = parse_offset(
        request.args.get("offset")
    )

    if offset is None:
        return (
            jsonify(
                {
                    "error": (
                        "Offset must be an integer "
                        "between 0 and 4999."
                    )
                }
            ),
            400,
        )

    # -----------------------------------------------------------------------
    # Cache
    # -----------------------------------------------------------------------

    cached_data = get_cached(
        animal,
        offset,
    )

    if cached_data is not None:
        response = jsonify(
            {
                "data": cached_data,
                "cached": True,
            }
        )

        # Browser can also cache this response briefly.
        response.headers["Cache-Control"] = (
            f"public, max-age={CACHE_TTL_SECONDS}"
        )

        return response

    # -----------------------------------------------------------------------
    # GIPHY request
    # -----------------------------------------------------------------------

    params = {
        "api_key": GIPHY_API_KEY,
        "q": f"{SEARCH_PREFIX} {animal}",
        "limit": FETCH_LIMIT,
        "offset": offset,
        "rating": RATING,
        "lang": "en",
    }

    try:
        response = http.get(
            GIPHY_SEARCH_URL,
            params=params,
            timeout=GIPHY_TIMEOUT,
        )

        response.raise_for_status()

    except requests.Timeout:
        app.logger.warning(
            "GIPHY request timed out."
        )

        return (
            jsonify(
                {
                    "error": (
                        "The GIF service took too long "
                        "to respond. Try again."
                    )
                }
            ),
            504,
        )

    except requests.RequestException as exc:
        # Never send this exception to the browser.
        #
        # Depending on the exception, it could contain the full URL,
        # including the private API key.
        app.logger.warning(
            "GIPHY request failed: %s",
            exc,
        )

        return (
            jsonify(
                {
                    "error": (
                        "Could not reach the GIF service. "
                        "Try again."
                    )
                }
            ),
            502,
        )

    # -----------------------------------------------------------------------
    # Content validation
    # -----------------------------------------------------------------------

    content_type = (
        response.headers.get("Content-Type", "")
        .lower()
    )

    if "application/json" not in content_type:
        app.logger.warning(
            "GIPHY returned unexpected content type: %s",
            content_type,
        )

        return (
            jsonify(
                {
                    "error": (
                        "Invalid response from the GIF service."
                    )
                }
            ),
            502,
        )

    # -----------------------------------------------------------------------
    # JSON parsing
    # -----------------------------------------------------------------------

    try:
        payload = response.json()

    except ValueError:
        app.logger.warning(
            "GIPHY returned invalid JSON."
        )

        return (
            jsonify(
                {
                    "error": (
                        "Invalid response from the GIF service."
                    )
                }
            ),
            502,
        )

    # -----------------------------------------------------------------------
    # Extract and cache
    # -----------------------------------------------------------------------

    gifs_out = extract_gifs(payload)

    set_cached(
        animal,
        offset,
        gifs_out,
    )

    result = {
        "data": gifs_out,
        "cached": False,
    }

    response = jsonify(result)

    response.headers["Cache-Control"] = (
        f"public, max-age={CACHE_TTL_SECONDS}"
    )

    return response


# ---------------------------------------------------------------------------
# Application entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(
        os.getenv("PORT", "5000")
    )

    debug = (
        os.getenv("FLASK_DEBUG", "0") == "1"
    )

    app.run(
        host="0.0.0.0",
        port=port,
        debug=debug,
    )
```
