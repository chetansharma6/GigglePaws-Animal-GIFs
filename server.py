"""
server.py — Flask backend for Animal GIFs.

Production notes:
- Configure RATELIMIT_STORAGE_URI to a shared Redis instance when running
  more than one worker/instance (or when ENVIRONMENT=production).
- Set TRUSTED_PROXY_HOPS to the exact number of trusted reverse proxies in
  front of Flask. Leave it at 0 when Flask is directly exposed.
- GIPHY_API_KEY is never written to logs.
"""

from __future__ import annotations

import hashlib
import json
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

try:
    import redis
except ImportError:  # pragma: no cover
    redis = None


load_dotenv()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

GIPHY_API_KEY = os.getenv("GIPHY_API_KEY")
GIPHY_SEARCH_URL = "https://api.giphy.com/v1/gifs/search"

SEARCH_PREFIX = "funny"
FETCH_LIMIT = 25
RATING = "g"

DEFAULT_RATE_LIMIT = os.getenv("DEFAULT_RATE_LIMIT", "120 per minute")
GIF_RATE_LIMIT = os.getenv("GIF_RATE_LIMIT", "40 per minute")

CACHE_TTL_SECONDS = int(os.getenv("CACHE_TTL_SECONDS", "60"))
CACHE_MAX_ENTRIES = int(os.getenv("CACHE_MAX_ENTRIES", "200"))

if CACHE_TTL_SECONDS <= 0:
    raise RuntimeError("CACHE_TTL_SECONDS must be > 0")

if CACHE_MAX_ENTRIES <= 0:
    raise RuntimeError("CACHE_MAX_ENTRIES must be > 0")

# Connection timeout = 3 seconds
# Read timeout = 10 seconds
GIPHY_TIMEOUT = (3, 10)

ENVIRONMENT = os.getenv("ENVIRONMENT", "development").lower()

# Development can use memory://.
# Production MUST use shared storage such as Redis.
RATELIMIT_STORAGE_URI = os.getenv(
    "RATELIMIT_STORAGE_URI",
    "memory://",
)

# Number of trusted reverse-proxy hops.
# 0 means no forwarded headers are trusted.
TRUSTED_PROXY_HOPS = int(
    os.getenv("TRUSTED_PROXY_HOPS", "0")
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

ANIMAL_PATTERN = re.compile(
    r"^[a-z]+(?:[ -][a-z]+)*$"
)


# ---------------------------------------------------------------------------
# Public files
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# HTTP client
# ---------------------------------------------------------------------------

http = requests.Session()

http.headers.update(
    {
        "User-Agent": "AnimalGIFs/1.0",
        "Accept": "application/json",
    }
)


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------

# Development/local fallback.
local_cache: dict[
    tuple[str, int],
    dict[str, Any],
] = {}

# Shared production cache when Redis is configured.
redis_cache = None


def _cache_key(animal: str, offset: int) -> str:
    """
    Build a stable cache key without putting arbitrary user input directly
    into the Redis key.
    """
    digest = hashlib.sha256(
        f"{animal}\0{offset}".encode()
    ).hexdigest()

    return f"animal-gifs:{digest}"


def get_cached(
    animal: str,
    offset: int,
) -> list[dict[str, str]] | None:
    """Return cached GIF data if it is still valid."""

    key = (animal, offset)

    if redis_cache is not None:
        raw = redis_cache.get(
            _cache_key(animal, offset)
        )

        if raw is None:
            return None

        try:
            value = json.loads(raw)
        except (TypeError, ValueError):
            return None

        return value if isinstance(value, list) else None

    entry = local_cache.get(key)

    if entry is None:
        return None

    if time.monotonic() >= entry["expires"]:
        local_cache.pop(key, None)
        return None

    return entry["data"]


def set_cached(
    animal: str,
    offset: int,
    data: list[dict[str, str]],
) -> None:
    """Store GIF data in the configured cache."""

    if redis_cache is not None:
        redis_cache.setex(
            _cache_key(animal, offset),
            CACHE_TTL_SECONDS,
            json.dumps(
                data,
                separators=(",", ":"),
            ),
        )
        return

    now = time.monotonic()

    # Remove expired entries.
    expired_keys = [
        key
        for key, entry in local_cache.items()
        if now >= entry["expires"]
    ]

    for key in expired_keys:
        local_cache.pop(key, None)

    # Evict oldest entries before insertion.
    while len(local_cache) >= CACHE_MAX_ENTRIES:
        oldest_key = next(iter(local_cache), None)

        if oldest_key is None:
            break

        local_cache.pop(oldest_key, None)

    local_cache[(animal, offset)] = {
        "expires": now + CACHE_TTL_SECONDS,
        "data": data,
    }


# ---------------------------------------------------------------------------
# Deployment configuration
# ---------------------------------------------------------------------------

def _configure_proxy(app: Flask) -> None:
    """
    Trust forwarding headers only when an explicit number of trusted
    reverse-proxy hops has been configured.
    """

    if TRUSTED_PROXY_HOPS < 0:
        raise RuntimeError(
            "TRUSTED_PROXY_HOPS must be >= 0"
        )

    if TRUSTED_PROXY_HOPS:
        app.wsgi_app = ProxyFix(
            app.wsgi_app,
            x_for=TRUSTED_PROXY_HOPS,
            x_proto=TRUSTED_PROXY_HOPS,
        )


def _configure_storage() -> None:
    """
    Configure shared storage.

    Production must not use memory:// because each worker/process would
    otherwise maintain an independent rate-limit state and cache.
    """

    global redis_cache

    if (
        ENVIRONMENT == "production"
        and RATELIMIT_STORAGE_URI.startswith("memory://")
    ):
        raise RuntimeError(
            "Production requires RATELIMIT_STORAGE_URI to point "
            "to shared storage (for example Redis); memory:// "
            "is per-process."
        )

    if RATELIMIT_STORAGE_URI.startswith(
        ("redis://", "rediss://")
    ):
        if redis is None:
            raise RuntimeError(
                "redis package is required when "
                "RATELIMIT_STORAGE_URI uses Redis"
            )

        redis_cache = redis.Redis.from_url(
            RATELIMIT_STORAGE_URI,
            decode_responses=True,
        )

        # Fail fast if Redis is unavailable.
        redis_cache.ping()


# ---------------------------------------------------------------------------
# Flask application
# ---------------------------------------------------------------------------

app = Flask(
    __name__,
    static_folder=None,
)

_configure_proxy(app)
_configure_storage()


# ---------------------------------------------------------------------------
# Rate limiting
# ---------------------------------------------------------------------------

limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=[DEFAULT_RATE_LIMIT],
    storage_uri=RATELIMIT_STORAGE_URI,
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

@app.after_request
def set_security_headers(response):
    """Add defensive security headers to every response."""

    response.headers["Content-Security-Policy"] = CSP

    response.headers["X-Content-Type-Options"] = (
        "nosniff"
    )

    response.headers["X-Frame-Options"] = "DENY"

    response.headers["Referrer-Policy"] = (
        "no-referrer"
    )

    response.headers["Permissions-Policy"] = (
        "geolocation=(), "
        "microphone=(), "
        "camera=()"
    )

    # Only send HSTS when HTTPS is actually being used.
    if request.is_secure:
        response.headers["Strict-Transport-Security"] = (
            "max-age=31536000; includeSubDomains"
        )

    response.headers["Server"] = "animal-gifs"

    return response


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

def validate_animal(
    raw_animal: str | None,
) -> str | None:
    """
    Validate and normalize an animal search term.

    Returns:
        Normalized animal name, or None if invalid.
    """

    animal = (
        raw_animal or ""
    ).strip().lower()

    if not animal:
        return None

    if len(animal) > 30:
        return None

    if not ANIMAL_PATTERN.fullmatch(animal):
        return None

    return animal


def parse_offset(
    raw_offset: str | None,
) -> int | None:
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


# ---------------------------------------------------------------------------
# GIPHY response helpers
# ---------------------------------------------------------------------------

def select_gif_url(
    images: dict[str, Any],
) -> str | None:
    """
    Select a reasonably sized GIF rendition.

    Avoid the original GIF unless no smaller rendition exists.
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


def extract_gifs(
    payload: Any,
) -> list[dict[str, str]]:
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

        selected_image = None

        for variant in (
            "downsized_medium",
            "downsized",
            "fixed_width",
            "fixed_height",
            "original",
        ):
            image = images.get(variant)

            if (
                isinstance(image, dict)
                and image.get("url") == url
            ):
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
# Safe logging
# ---------------------------------------------------------------------------

def _safe_request_error(
    exc: requests.RequestException,
) -> str:
    """
    Return a log-safe error.

    requests exceptions may contain the prepared URL, which could contain
    the private GIPHY API key. Never stringify the exception itself.
    """

    return (
        f"{type(exc).__name__}: "
        "upstream GIPHY request failed"
    )


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
            ],
            "cached": false
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
        # IMPORTANT:
        # Do not log `exc`, because it can contain the complete URL
        # including the private API key.
        app.logger.warning(
            _safe_request_error(exc)
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
        response.headers
        .get("Content-Type", "")
        .lower()
    )

    if "application/json" not in content_type:
        app.logger.warning(
            "GIPHY returned unexpected content type: %s",
            content_type[:100],
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

def main() -> None:
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


if __name__ == "__main__":
    main()
