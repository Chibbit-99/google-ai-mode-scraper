#!/usr/bin/env python3
"""
Google AI Mode terminal runner — v1.1.0

Launches Google AI Mode with Playwright, injects js/v1.0.0.js, submits a
terminal/CLI prompt, and streams the extractor's Markdown output to stdout.

Local install:
    python -m pip install playwright
    python -m playwright install chromium

Local interactive run:
    python py/v1.1.0.py

Headless/CI run:
    python py/v1.1.0.py --headless --prompt "Explain quantum entanglement"

For CI accounts that require Google sign-in, provide a Playwright storage-state
JSON file with --storage-state. Treat that file like a password.
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
            # Google's page can emit CSP notices for its own inline event
            # handlers. The extractor does not create HTML event-handler
            # attributes, so report this separately from runner exceptions.
            if "Executing inline event handler violates the following Content Security Policy" in message.text:
                print(
                    f"\n[BROWSER CSP NOTICE] {message.text}",
                    file=sys.stderr,
                    flush=True,
                )
                return

            print(f"\n[BROWSER ERROR] {message.text}", file=sys.stderr, flush=True)
            return

        label = ""
        payload: Any = None

        try:
            args = message.args
            if len(args) >= 2:
                label = str(args[0].json_value())
                payload = args[1].json_value()
        except (PlaywrightError, TypeError, ValueError):
            pass

        marker = next((item for item in STREAM_MARKERS if item in label), None)

        # Fallback for Playwright versions that do not expose console args.
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


def page_diagnostics(page: Any) -> dict[str, Any]:
    """Summarize page rendering and visible controls without dumping page text."""
    try:
        return page.evaluate("""() => {
            const visible = el => {
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 &&
                       style.visibility !== 'hidden' && style.display !== 'none';
            };
            const body = document.body;
            const bodyText = body ? (body.innerText || '').toLowerCase() : '';
            const controls = [...document.querySelectorAll(
                'textarea, input, [contenteditable="true"], [role="textbox"]'
            )];
            return {
                url: location.href,
                title: document.title,
                readyState: document.readyState,
                bodyTextLength: body ? (body.innerText || '').length : 0,
                bodyChildCount: body ? body.children.length : 0,
                scriptCount: document.scripts.length,
                iframeCount: document.querySelectorAll('iframe').length,
                mainCount: document.querySelectorAll('main').length,
                visibleControls: controls.filter(visible).slice(0, 20).map(el => ({
                    tag: el.tagName,
                    type: el.getAttribute('type'),
                    role: el.getAttribute('role'),
                    ariaLabel: el.getAttribute('aria-label'),
                    placeholder: el.getAttribute('placeholder'),
                    contenteditable: el.getAttribute('contenteditable')
                })),
                pageIndicators: {
                    captcha: bodyText.includes('captcha') || bodyText.includes('unusual traffic'),
                    signIn: bodyText.includes('sign in'),
                    consent: bodyText.includes('before you continue'),
                    javascriptDisabled: bodyText.includes('enable javascript') || bodyText.includes('javascript is not enabled'),
                    blocked: bodyText.includes('our systems have detected') || bodyText.includes('automated queries')
                },
                bodyChildren: body ? [...body.children].slice(0, 12).map(el => ({
                    tag: el.tagName,
                    id: el.id || null,
                    role: el.getAttribute('role'),
                    className: (typeof el.className === 'string' ? el.className : '').slice(0, 120),
                    textLength: (el.innerText || '').length
                })) : []
            };
        }""")
    except PlaywrightError as error:
        return {"url": getattr(page, "url", "(unknown)"), "diagnostic_error": str(error)}

def save_page_debug(page: Any, debug_dir: Path) -> None:
    """Save selector metadata only, not page HTML or private page text."""
    try:
        debug_dir.mkdir(parents=True, exist_ok=True)
        details = page_diagnostics(page)
        (debug_dir / "page-diagnostics.json").write_text(
            json.dumps(details, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        print(f"[DEBUG] Selector diagnostics saved to {debug_dir / 'page-diagnostics.json'}", flush=True)
    except (PlaywrightError, OSError) as error:
        print(f"[DEBUG] Could not save selector diagnostics: {error}", flush=True)


def wait_for_prompt_box(page: Any, timeout_seconds: int, debug_dir: Path) -> None:
    """Wait for the extractor's composer selector and periodically report state."""
    # Google currently renders two matching composers; v1.0.0.js uses
    # document.querySelector(), so wait for the first matching textarea.
    selector = page.locator(TEXTAREA_SELECTOR).first
    deadline = time.monotonic() + timeout_seconds
    next_report = time.monotonic()
    print(
        f"Waiting up to {timeout_seconds}s for selector: {TEXTAREA_SELECTOR}",
        flush=True,
    )

    while time.monotonic() < deadline:
        remaining_ms = max(1, int((deadline - time.monotonic()) * 1000))
        try:
            selector.wait_for(state="visible", timeout=min(5_000, remaining_ms))
            print("[READY] Google AI Mode prompt box detected.", flush=True)
            return
        except PlaywrightTimeoutError:
            now = time.monotonic()
            if now >= next_report:
                print(
                    "[WAITING FOR COMPOSER] " + json.dumps(page_diagnostics(page), ensure_ascii=False),
                    flush=True,
                )
                next_report = now + 10

    details = page_diagnostics(page)
    save_page_debug(page, debug_dir)
    raise RuntimeError(
        "Google AI Mode loaded, but the expected composer selector was not found. "
        "The redirect to /search?udm=50 is normal for AI Mode; it is not the error. "
        f"Expected selector: {TEXTAREA_SELECTOR}. "
        f"Page rendering diagnostics: {json.dumps(details, ensure_ascii=False)}"
    )

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
    storage_state: Path | None = (
        args.storage_state.expanduser().resolve()
        if args.storage_state
        else None
    )

    if not script_path.is_file():
        print(f"Extractor not found: {script_path}", file=sys.stderr)
        print(
            "Expected the repository layout to contain js/v1.0.0.js.",
            file=sys.stderr,
        )
        return 1

    if storage_state and not storage_state.is_file():
        print(f"Storage-state file not found: {storage_state}", file=sys.stderr)
        return 1

    source = script_path.read_text(encoding="utf-8")
    if "window.__aiModeExtractor" not in source:
        print(
            "The selected JavaScript file does not look like the v1.0.0 extractor.",
            file=sys.stderr,
        )
        return 1

    profile_dir.mkdir(parents=True, exist_ok=True)

    print(f"Google AI Mode terminal runner v{VERSION}")
    print(f"Extractor: {script_path}")
    print(f"Browser mode: {'headless' if args.headless else 'headed'}", flush=True)

    browser = None
    context = None

    with sync_playwright() as playwright:
        try:
            if args.headless or storage_state:
                # CI uses an ephemeral browser context. Optional storage state
                # restores an authenticated Google session.
                browser = playwright.chromium.launch(headless=args.headless)
                context = browser.new_context(
                    storage_state=str(storage_state) if storage_state else None,
                    viewport={"width": 1440, "height": 1000},
                )
            else:
                # Local interactive runs retain the Google login between runs.
                context = playwright.chromium.launch_persistent_context(
                    user_data_dir=str(profile_dir),
                    headless=False,
                    viewport=None,
                    args=["--start-maximized"],
                )

            page = context.pages[0] if context.pages else context.new_page()
            page.set_default_timeout(15_000)
            stream_stats = attach_terminal_stream(page)
            page.on(
                "pageerror",
                lambda error: print(
                    f"\n[BROWSER PAGE ERROR] {error}",
                    file=sys.stderr,
                    flush=True,
                ),
            )

            print(f"Opening {args.url} ...", flush=True)
            response = page.goto(
                args.url,
                wait_until="domcontentloaded",
                timeout=60_000,
            )
            print(
                f"[NAVIGATION] HTTP {response.status if response else 'unknown'} "
                f"| final URL: {page.url}",
                flush=True,
            )
            try:
                page.wait_for_load_state("load", timeout=15_000)
            except PlaywrightTimeoutError:
                print("[NAVIGATION] Full load event did not fire within 15s; continuing.", flush=True)
            print("[PAGE AFTER LOAD] " + json.dumps(page_diagnostics(page), ensure_ascii=False), flush=True)

            wait_for_prompt_box(page, args.ready_timeout, args.debug_dir.expanduser().resolve())

            prompt = args.prompt.strip() if args.prompt is not None else read_prompt()
            if not prompt:
                print("No prompt supplied; exiting without submitting.")
                return 0

            injected = build_injected_script(source, prompt)

            print("\nSubmitting prompt and streaming the response below.\n", flush=True)
            # Evaluate through Playwright rather than appending an inline
            # <script> element. Google's nonce/strict-dynamic CSP can reject
            # script elements without its per-page nonce. Its current policy
            # explicitly permits unsafe-eval, so eval() is available here.
            page.evaluate("(script) => { (0, eval)(script); return true; }", injected)

            # The extractor submits the prompt asynchronously and exposes its
            # controller immediately, before waiting for Google's response.
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
                    "finding a new AI Mode reply. Check Google's current "
                    "page structure and account access.",
                    file=sys.stderr,
                )
                return 2

            markdown = page.evaluate(
                "() => window.lastExtractedMarkdown || ''"
            )
            if not markdown.strip():
                print(
                    "\n[EMPTY RESPONSE] A reply was detected, but no Markdown "
                    "was extracted.",
                    file=sys.stderr,
                )
                return 2

            # Usually the complete output has already streamed. This fallback
            # covers cases where the browser console did not emit stream events.
            if not (
                stream_stats["blocks"]
                or stream_stats["chunks"]
                or stream_stats["edits"]
            ):
                print(markdown, flush=True)

            elapsed = final_status.get("elapsed", "unknown")
            print(
                "\n\n[TEST PASSED] "
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
            if context is not None:
                context.close()
            if browser is not None:
                browser.close()


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
        default=240,
        help="Maximum seconds to wait for extraction to finish (default: 240).",
    )
    parser.add_argument(
        "--ready-timeout",
        type=int,
        default=90,
        help="Seconds to wait for the Google AI Mode prompt box (default: 90).",
    )
    parser.add_argument(
        "--url",
        default=AI_MODE_URL,
        help=f"Google AI Mode URL (default: {AI_MODE_URL})",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="Run Chromium without a visible browser window (for CI).",
    )
    parser.add_argument(
        "--prompt",
        help="Prompt to submit; omitting it starts interactive terminal input.",
    )
    parser.add_argument(
        "--debug-dir",
        type=Path,
        default=Path("debug-output"),
        help="Directory for selector diagnostics when the composer is missing.",
    )
    parser.add_argument(
        "--storage-state",
        type=Path,
        help="Optional Playwright storage-state JSON file for Google sign-in.",
    )
    args = parser.parse_args()

    if args.timeout < 1:
        parser.error("--timeout must be at least 1 second")
    if args.ready_timeout < 1:
        parser.error("--ready-timeout must be at least 1 second")
    if args.prompt is not None and not args.prompt.strip():
        parser.error("--prompt cannot be empty")

    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
