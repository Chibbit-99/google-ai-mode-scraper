#!/usr/bin/env python3
"""
Google AI Mode terminal runner — v1.1.0

Launches a persistent Playwright Chromium profile, opens Google AI Mode,
loads ../js/v1.0.0.js, asks for a prompt in the terminal, and streams the
extractor's Markdown output back to the terminal.

Install:
    python -m pip install playwright
    python -m playwright install chromium

Run from any working directory:
    python py/v1.1.0.py

The first run opens a fresh browser profile. Sign in to Google in that
window; the session is retained in ~/.local/share/google-ai-mode-scraper.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

from playwright.sync_api import (
    Error as PlaywrightError,
    TimeoutError as PlaywrightTimeoutError,
    sync_playwright,
)

VERSION = "1.1.0"
AI_MODE_URL = "https://www.google.com/ai"
TEXTAREA_SELECTOR = 'textarea[aria-label="Ask anything"]'
DEFAULT_SCRIPT = Path(__file__).resolve().parents[1] / "js" / "v1.0.0.js"
DEFAULT_PROFILE = (
    Path.home()
    / ".local"
    / "share"
    / "google-ai-mode-scraper"
    / "chromium-profile"
)
STREAM_MARKERS = ("[BLOCK]", "[MARKDOWN CHUNK]", "[EDIT]")


def build_injected_script(source: str, prompt: str) -> str:
    """Set the v1.0.0 prompt and wrap its top-level await in an async IIFE."""
    source, replacements = re.subn(
        r"^var prompt\s*=.*;$",
        lambda _: "var prompt = " + json.dumps(prompt, ensure_ascii=False) + ";",
        source,
        count=1,
        flags=re.MULTILINE,
    )

    if replacements != 1:
        raise RuntimeError(
            "Could not find the expected 'var prompt = ...;' declaration "
            "in js/v1.0.0.js."
        )

    # The original DevTools script uses top-level await. A classic script
    # element does not allow that syntax, so execute it inside an async IIFE.
    return (
        "(async () => {\n"
        + source
        + "\n})().catch(error => console.error('[PYTHON RUNNER ERROR]', error));"
    )


def attach_terminal_stream(page: Any) -> dict[str, int]:
    """Forward the extractor's block/chunk/edit console events to stdout."""
    stats = {"blocks": 0, "chunks": 0, "edits": 0}

    def on_console(message: Any) -> None:
        if message.type == "error":
            print(f"\n[BROWSER ERROR] {message.text}", file=sys.stderr, flush=True)
            return

        label = ""
        payload: Any = None

        # Playwright exposes console arguments separately. Reading them this
        # way preserves the exact Markdown string (including leading spaces).
        try:
            args = message.args
            if len(args) >= 2:
                label = str(args[0].json_value())
                payload = args[1].json_value()
        except (PlaywrightError, TypeError, ValueError):
            pass

        marker = next((item for item in STREAM_MARKERS if item in label), None)

        # Fallback for browser/Playwright versions that do not expose args.
        if marker is None:
            text = message.text
            marker = next((item for item in STREAM_MARKERS if item in text), None)
            if marker is None:
                return
            payload = text.split(marker, 1)[1].lstrip()

        if not isinstance(payload, str):
            payload = str(payload)

        if marker == "[BLOCK]":
            stats["blocks"] += 1
            print(payload + "\n", end="", flush=True)
        elif marker == "[MARKDOWN CHUNK]":
            stats["chunks"] += 1
            print(payload, end="", flush=True)
        elif marker == "[EDIT]":
            stats["edits"] += 1
            print("\n\n[UPDATED BLOCK]\n" + payload + "\n", flush=True)

    page.on("console", on_console)
    return stats


def wait_for_prompt_box(page: Any) -> None:
    """Wait until AI Mode is ready; allow manual sign-in/consent in the browser."""
    print("\nWaiting for Google's 'Ask anything' box.")
    print("Complete any sign-in or consent steps in the opened browser window.")

    while True:
        try:
            page.locator(TEXTAREA_SELECTOR).wait_for(
                state="visible",
                timeout=30_000,
            )
            return
        except PlaywrightTimeoutError:
            print("Still waiting for the AI Mode prompt box...")


def read_prompt() -> str:
    while True:
        try:
            prompt = input("\nPrompt (or /exit): ").strip()
        except EOFError:
            return ""

        if prompt.lower() == "/exit":
            return ""
        if prompt:
            return prompt

        print("Enter a non-empty prompt.")


def run(args: argparse.Namespace) -> int:
    script_path: Path = args.script.expanduser().resolve()
    profile_dir: Path = args.profile_dir.expanduser().resolve()

    if not script_path.is_file():
        print(f"Extractor not found: {script_path}", file=sys.stderr)
        print(
            "Expected the repository layout to contain js/v1.0.0.js.",
            file=sys.stderr,
        )
        return 1

    source = script_path.read_text(encoding="utf-8")
    if "window.__aiModeExtractor" not in source:
        print("The selected JavaScript file does not look like the v1.0.0 extractor.",
              file=sys.stderr)
        return 1

    profile_dir.mkdir(parents=True, exist_ok=True)

    print(f"Google AI Mode terminal runner v{VERSION}")
    print(f"Extractor: {script_path}")
    print(f"Browser profile: {profile_dir}")

    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            user_data_dir=str(profile_dir),
            headless=False,
            viewport=None,
            args=["--start-maximized"],
        )

        try:
            page = context.pages[0] if context.pages else context.new_page()
            page.set_default_timeout(15_000)
            stream_stats = attach_terminal_stream(page)

            print(f"Opening {AI_MODE_URL} ...")
            page.goto(
                AI_MODE_URL,
                wait_until="domcontentloaded",
                timeout=60_000,
            )

            wait_for_prompt_box(page)
            prompt = read_prompt()
            if not prompt:
                print("Exiting without submitting a prompt.")
                return 0

            injected = build_injected_script(source, prompt)

            print("\nSubmitting prompt and streaming the response below.\n")
            page.add_script_tag(content=injected)

            # The extractor submits the prompt asynchronously and exposes a
            # status controller as soon as its script starts.
            page.wait_for_function(
                "() => !!(window.__aiModeExtractor && "
                "typeof window.__aiModeExtractor.status === 'function')",
                timeout=10_000,
            )

            deadline = time.monotonic() + args.timeout
            final_status = None

            while time.monotonic() < deadline:
                final_status = page.evaluate(
                    "() => window.__aiModeExtractor.status()"
                )

                if final_status.get("finished"):
                    break

                time.sleep(0.4)
            else:
                print(
                    f"\n[RUNNER TIMEOUT] No completion after {args.timeout} seconds.",
                    file=sys.stderr,
                )
                page.evaluate(
                    "() => window.__aiModeExtractor && "
                    "window.__aiModeExtractor.stop()"
                )
                return 2

            if not final_status.get("responseDetected"):
                print(
                    "\n[NO RESPONSE DETECTED] The extractor stopped before "
                    "finding a new AI Mode reply. Check the browser page and "
                    "Google's current DOM/selectors.",
                    file=sys.stderr,
                )
                return 2

            markdown = page.evaluate(
                "() => window.lastExtractedMarkdown || ''"
            )

            # The normal path streams all content live. Print the final
            # snapshot only when no stream events were received.
            if markdown and not (
                stream_stats["blocks"]
                or stream_stats["chunks"]
                or stream_stats["edits"]
            ):
                print(markdown, flush=True)

            elapsed = final_status.get("elapsed", "unknown")
            print(
                "\n\n[COMPLETE] "
                f"{elapsed} | "
                f"{stream_stats['blocks']} blocks, "
                f"{stream_stats['chunks']} chunks, "
                f"{stream_stats['edits']} edits",
                flush=True,
            )
            return 0

        except KeyboardInterrupt:
            print("\nInterrupted. Closing the browser.")
            return 130
        except (PlaywrightError, RuntimeError, OSError) as error:
            print(f"\n[ERROR] {error}", file=sys.stderr)
            return 1
        finally:
            context.close()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run the Google AI Mode v1.0.0 extractor from a terminal."
    )
    parser.add_argument(
        "--script",
        type=Path,
        default=DEFAULT_SCRIPT,
        help=f"Path to the extractor JavaScript (default: {DEFAULT_SCRIPT})",
    )
    parser.add_argument(
        "--profile-dir",
        type=Path,
        default=DEFAULT_PROFILE,
        help=f"Persistent Chromium profile directory (default: {DEFAULT_PROFILE})",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=180,
        help="Maximum seconds to wait for the extractor to finish (default: 180).",
    )
    parser.add_argument(
        "--url",
        default=AI_MODE_URL,
        help=f"Google AI Mode URL (default: {AI_MODE_URL})",
    )
    args = parser.parse_args()

    if args.timeout < 1:
        parser.error("--timeout must be at least 1 second")

    # Keep the URL override local to this run.
    global AI_MODE_URL
    AI_MODE_URL = args.url

    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
