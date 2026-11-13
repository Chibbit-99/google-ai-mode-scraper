/*
 * Google AI Mode Scraper — v9 integration test runner
 *
 * Tests:
 *   1. Citation/source exclusion
 *   2. Consecutive questions / newest-response detection
 *   3. Markdown structure preservation
 *   4. Stop/restart and observer lifecycle
 *
 * IMPORTANT:
 * - This is a manual integration-test harness, not a replacement for v9.js.
 * - Run this file once in DevTools on a Google AI Mode page.
 * - For each test, set the prompt in js/v9.js, then run v9.js.
 * - After v9 reports [COMPLETE], call window.__v9Test1.end().
 * - DevTools snippets use var (no top-level let/const).
 */

var key = "__v9Test1";

if (window[key] && window[key].active) {
    console.warn("[v9-test1] Previous test runner is already active.");
} else {

    var cases = {
        citations: {
            title: "Citation and source exclusion",
            prompt: "Explain the causes of the 2020 Australian bushfire season. Use several reliable sources, cite your claims, and include a source list.",
            checks: [
                "The answer contains the explanation.",
                "Inline citation markers are absent from extracted Markdown.",
                "Source cards, source URLs, 'Show all', and related-source UI are absent.",
                "The answer's final paragraph is retained."
            ]
        },
        consecutive: {
            title: "Consecutive questions",
            prompts: [
                "Explain how photosynthesis works.",
                "Now explain cellular respiration and compare it with photosynthesis."
            ],
            checks: [
                "The second run contains the cellular-respiration response.",
                "The second run does not contain the first answer unless it is repeated as comparison.",
                "The extractor attaches to the newest AI Mode reply."
            ]
        },
        structures: {
            title: "Markdown structure preservation",
            prompt: "Create a compact guide to sorting numbers in JavaScript. Include a heading, a numbered list with at least three steps, a nested bullet list, a table comparing ascending and descending order, a JavaScript code example, and bold and italic text.",
            checks: [
                "Headings are represented with # markers.",
                "Numbered and nested bullet lists retain their hierarchy.",
                "The comparison table is retained in a readable form.",
                "The code example and inline formatting are preserved where Google exposes them as formatted DOM."
            ]
        },
        lifecycle: {
            title: "Stop and restart",
            prompt: "Explain the difference between RAM and storage in a computer.",
            checks: [
                "Calling stop() marks the old controller as finished.",
                "Starting v9 again replaces the old controller.",
                "The old controller is stopped before the new run starts.",
                "The restarted run extracts a fresh answer without carrying over old Markdown."
            ]
        }
    };

    var state = {
        active: true,
        current: null,
        runs: [],
        previousController: null,
        previousMarkdown: ""
    };

    var log = function (label, data) {
        if (typeof data === "undefined") {
            console.log("[v9-test1] " + label);
        } else {
            console.log("[v9-test1] " + label, data);
        }
    };

    var getStatus = function (controller) {
        try {
            return controller && typeof controller.status === "function"
                ? controller.status()
                : null;
        } catch (error) {
            return { statusError: String(error) };
        }
    };

    var inspectMarkdown = function (markdown, testId) {
        var text = markdown || "";
        var lines = text.split("\n");
        var countLines = function (test) {
            return lines.filter(test).length;
        };
        var countText = function (needle) {
            var count = 0;
            var position = 0;
            while ((position = text.indexOf(needle, position)) !== -1) {
                count++;
                position += needle.length || 1;
            }
            return count;
        };
        var findings = {
            characters: text.length,
            headings: countLines(function (line) {
                var trimmed = line.trim();
                var hashes = 0;
                while (trimmed.charAt(hashes) === "#") hashes++;
                return hashes > 0 && hashes <= 6 && trimmed.charAt(hashes) === " ";
            }),
            unorderedItems: countLines(function (line) {
                return line.trim().indexOf("- ") === 0;
            }),
            orderedItems: countLines(function (line) {
                var trimmed = line.trim();
                var dot = trimmed.indexOf(". ");
                return dot > 0 && !isNaN(Number(trimmed.slice(0, dot)));
            }),
            markdownLinks: countText("]("),
            urls: countText("http://") + countText("https://"),
            citationLikeMarkers: countText("cite") + countText("[1]") + countText("[2]") + countText("[3]") + countText("(Source:"),
            sourceUiText: ["show all", "show less", "related searches", "sources"].some(function (word) {
                return text.toLowerCase().indexOf(word) !== -1;
            }),
            codeFences: countText("```")
        };
        if (testId === "structures") {
            findings.hasTable = countLines(function (line) {
                return line.indexOf("|") !== -1;
            }) >= 2 && countLines(function (line) {
                return line.indexOf("---") !== -1;
            }) > 0;
            findings.hasBold = text.indexOf("**") !== -1;
            findings.hasItalic = text.indexOf("*") !== -1;
            findings.hasNestedIndent = countLines(function (line) {
                return line.indexOf("  - ") === 0 || line.indexOf("    - ") === 0 || line.indexOf("\t- ") === 0;
            }) > 0;
        }

        return findings;
    };

    var begin = function (testId, runLabel) {
        var testCase = cases[testId];

        if (!testCase) {
            console.error("[v9-test1] Unknown test:", testId);
            console.info("[v9-test1] Available tests:", Object.keys(cases));
            return;
        }

        var oldController = window.__aiModeExtractor || null;
        var oldStatus = getStatus(oldController);

        state.current = {
            id: testId,
            label: runLabel || testCase.title,
            startedAt: new Date().toISOString(),
            previousController: oldController,
            previousStatus: oldStatus,
            previousMarkdown: window.lastExtractedMarkdown || ""
        };

        state.previousController = oldController;
        state.previousMarkdown = window.lastExtractedMarkdown || "";

        log("BEGIN: " + testCase.title);
        log("Prompt to use in js/v9.js:", testCase.prompt || testCase.prompts);
        log("Before-run controller state:", oldStatus);
        log("Next: set the prompt in v9.js, execute v9.js, wait for [COMPLETE], then call __v9Test1.end().");

        return testCase;
    };

    var end = function () {
        if (!state.current) {
            console.warn("[v9-test1] No test is currently in progress. Call begin(testId) first.");
            return null;
        }

        var run = state.current;
        var controller = window.__aiModeExtractor || null;
        var status = getStatus(controller);
        var markdown = window.lastExtractedMarkdown || "";
        var findings = inspectMarkdown(markdown, run.id);

        var result = {
            test: run.id,
            label: run.label,
            completedAt: new Date().toISOString(),
            controllerReplaced: !!controller && controller !== run.previousController,
            previousControllerStopped: run.previousController
                ? !!(getStatus(run.previousController) || {}).finished
                : null,
            currentControllerFinished: status ? status.finished : null,
            responseDetected: status ? status.responseDetected : null,
            markdownChanged: markdown !== run.previousMarkdown,
            markdownLength: markdown.length,
            findings: findings,
            streaming: status ? status.answerStreaming : null,
            blocks: status ? status.blocks : null,
            markdown: markdown
        };

        if (run.id === "citations") {
            result.warnings = [];
            if (findings.citationLikeMarkers) result.warnings.push("Citation-like markers remain in Markdown.");
            if (findings.urls) result.warnings.push("One or more URLs remain in Markdown.");
            if (findings.sourceUiText) result.warnings.push("Source-related UI text may have leaked into Markdown; inspect manually.");
            result.pass = markdown.length > 0 && result.warnings.length === 0;
        } else if (run.id === "consecutive") {
            result.pass = markdown.length > 0 && result.markdownChanged && result.controllerReplaced;
        } else if (run.id === "structures") {
            result.pass = markdown.length > 0 &&
                findings.headings > 0 &&
                findings.orderedItems > 0 &&
                findings.unorderedItems > 0 &&
                findings.hasTable &&
                findings.codeFences >= 2 &&
                findings.hasBold;
            result.note = "Google may not render every requested structure; manually inspect the answer and DOM before treating missing structures as an extractor failure.";
        } else if (run.id === "lifecycle") {
            result.pass = !!controller &&
                controller !== run.previousController &&
                (!run.previousController || !!(getStatus(run.previousController) || {}).finished) &&
                !!status &&
                status.responseDetected;
        }

        state.runs.push(result);
        state.current = null;

        log("RESULT: " + run.id, result);
        return result;
    };

    var stopAndCheck = function () {
        var controller = window.__aiModeExtractor || null;

        if (!controller) {
            console.warn("[v9-test1] No active extractor controller.");
            return null;
        }

        controller.stop();

        var status = getStatus(controller);
        var result = {
            stopped: !!(status && status.finished),
            status: status
        };

        log("STOP CHECK", result);
        return result;
    };

    var report = function () {
        var summary = state.runs.map(function (run, index) {
            return {
                number: index + 1,
                test: run.test,
                pass: run.pass,
                markdownLength: run.markdownLength,
                findings: run.findings,
                warnings: run.warnings || []
            };
        });

        console.table(summary);
        log("FULL REPORT", state.runs);
        return state.runs;
    };

    var help = function () {
        console.log(
            "[v9-test1] MANUAL TEST SEQUENCE\n" +
            "1) Citations: begin('citations'); set v9.js prompt to cases.citations.prompt; run v9.js; after [COMPLETE], end().\n" +
            "2) Consecutive: begin('consecutive'); run v9.js with prompts[0], end(); then begin('consecutive','Consecutive question 2'); run v9.js with prompts[1], end().\n" +
            "3) Structures: begin('structures'); set v9.js prompt to cases.structures.prompt; run v9.js; after [COMPLETE], end().\n" +
            "4) Lifecycle: begin('lifecycle'); run v9.js with the RAM/storage prompt; while it is STILL STREAMING, call stopAndCheck(); then begin('lifecycle','Restart run'); run v9.js again with a fresh prompt; after [COMPLETE], end().\n" +
            "Use report() to see all recorded results."
        );
        console.table(Object.keys(cases).map(function (id) {
            return { id: id, title: cases[id].title };
        }));
    };

    window[key] = {
        active: true,
        cases: cases,
        state: state,
        begin: begin,
        end: end,
        stopAndCheck: stopAndCheck,
        report: report,
        help: help,
        inspectMarkdown: inspectMarkdown
    };

    log("Test runner installed.");
    help();
}