/*
 * Automated Google AI Mode Scraper v10 integration tests.
 * Paste this file into DevTools on an AI Mode page, then run:
 *   await window.__v10AutoTest.run()
 *
 * Runs six prompts: citation filtering, two consecutive responses,
 * Markdown structure, stop-during-stream, and restart.
 * The runner fetches the current js/v10.js from this repository.
 */

var autoTestState = {
    running: false,
    cancelled: false,
    results: [],
    controller: null,
    extractorSource: null
};

var autoTestWait = function (ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
};

var autoTestLog = function (message, data) {
    if (typeof data === "undefined") console.log("[v10-test-auto] " + message);
    else console.log("[v10-test-auto] " + message, data);
};

var autoTestFetchExtractor = async function () {
    var url = "https://raw.githubusercontent.com/Chibbit-99/google-ai-mode-scraper/main/js/v10.js";
    var response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error("Fetching v10.js failed: HTTP " + response.status);
    var source = await response.text();
    if (source.indexOf('var prompt = "Explain quantum entanglement.";') === -1) {
        throw new Error("Unexpected v10.js source: prompt template was not found.");
    }
    return source;
};

var autoTestLaunch = async function (prompt) {
    if (autoTestState.cancelled) throw new Error("Cancelled.");
    var original = 'var prompt = "Explain quantum entanglement.";';
    var replacement = "var prompt = " + JSON.stringify(prompt) + ";";
    var source = autoTestState.extractorSource.replace(original, replacement);
    if (source === autoTestState.extractorSource) {
        throw new Error("Could not substitute prompt into v10.js.");
    }

    var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction(source)();

    autoTestState.controller = window.__aiModeExtractor;
    if (!autoTestState.controller) throw new Error("v10.js did not expose its controller.");
    return autoTestState.controller;
};

var autoTestWaitFinished = async function (controller, timeoutMs) {
    var started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (autoTestState.cancelled) throw new Error("Cancelled.");
        var status = controller.status();
        if (status && status.finished) return status;
        await autoTestWait(250);
    }
    throw new Error("Timed out waiting for the response to finish.");
};

var autoTestWaitForLiveText = async function (controller, timeoutMs) {
    var started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (autoTestState.cancelled) throw new Error("Cancelled.");
        var status = controller.status();
        var stream = status && status.answerStreaming;
        if (status && status.finished) return status;
        if (status && status.responseDetected && stream &&
            stream.characterMutations > 0) return status;
        await autoTestWait(100);
    }
    throw new Error("No live character mutation was detected in time.");
};

var autoTestCount = function (text, needle) {
    var count = 0;
    var index = 0;
    while ((index = text.indexOf(needle, index)) !== -1) {
        count++;
        index += needle.length || 1;
    }
    return count;
};

var autoTestInspect = function (markdown) {
    var text = markdown || "";
    var lines = text.split("\n");
    var trimmed = lines.map(function (line) { return line.trim(); });
    return {
        characters: text.length,
        headings: trimmed.filter(function (line) {
            var n = 0;
            while (line.charAt(n) === "#") n++;
            return n > 0 && n <= 6 && line.charAt(n) === " ";
        }).length,
        orderedItems: trimmed.filter(function (line) {
            var dot = line.indexOf(". ");
            return dot > 0 && !isNaN(Number(line.slice(0, dot)));
        }).length,
        unorderedItems: trimmed.filter(function (line) { return line.indexOf("- ") === 0; }).length,
        nestedItems: lines.filter(function (line) {
            return line.indexOf("  - ") === 0 || line.indexOf("    - ") === 0 || line.indexOf("\t- ") === 0;
        }).length,
        tableLines: lines.filter(function (line) { return line.indexOf("|") !== -1; }).length,
        tableSeparator: lines.some(function (line) {
            return line.indexOf("|") !== -1 && line.indexOf("---") !== -1;
        }),
        codeFences: autoTestCount(text, "```"),
        boldMarkers: autoTestCount(text, "**"),
        urls: autoTestCount(text, "https://") + autoTestCount(text, "http://"),
        citationMarkers: autoTestCount(text, "cite") +
            autoTestCount(text, "[1]") + autoTestCount(text, "[2]") + autoTestCount(text, "[3]"),
        sourceUiText: ["show all", "show less", "related searches"].some(function (phrase) {
            return text.toLowerCase().indexOf(phrase) !== -1;
        })
    };
};

var autoTestRecord = function (name, pass, details) {
    var item = { test: name, pass: !!pass, details: details };
    autoTestState.results.push(item);
    autoTestLog((item.pass ? "PASS " : "FAIL ") + name, details);
    return item;
};

var autoTestRun = async function () {
    if (autoTestState.running) throw new Error("A test run is already active.");
    if (!document.querySelector('textarea[aria-label="Ask anything"]')) {
        throw new Error("Open Google AI Mode first; the Ask anything textarea was not found.");
    }

    autoTestState.running = true;
    autoTestState.cancelled = false;
    autoTestState.results = [];

    try {
        autoTestLog("Fetching latest v10.js...");
        autoTestState.extractorSource = await autoTestFetchExtractor();

        // 1. Citation/source exclusion
        await autoTestLaunch("Explain the main causes of the 2020 Australian bushfire season. Cite factual claims and include a short source list.");
        var s1 = await autoTestWaitFinished(autoTestState.controller, 150000);
        var m1 = window.lastExtractedMarkdown || "";
        var f1 = autoTestInspect(m1);
        autoTestRecord("1. Citation/source exclusion",
            m1.length > 0 && f1.urls === 0 && f1.citationMarkers === 0 && !f1.sourceUiText,
            { status: s1, findings: f1, markdown: m1 });

        // 2. Consecutive prompts; verify the second controller and response are new.
        await autoTestLaunch("Explain photosynthesis in plants, including sunlight, water, and carbon dioxide.");
        var firstController = autoTestState.controller;
        var s2a = await autoTestWaitFinished(firstController, 150000);
        var m2a = window.lastExtractedMarkdown || "";

        await autoTestLaunch("Now explain cellular respiration and compare it with photosynthesis.");
        var secondController = autoTestState.controller;
        var s2b = await autoTestWaitFinished(secondController, 150000);
        var m2b = window.lastExtractedMarkdown || "";
        autoTestRecord("2. Consecutive questions / newest response",
            secondController !== firstController &&
            !!m2b &&
            m2b.toLowerCase().indexOf("cellular respiration") !== -1 &&
            m2b !== m2a,
            { firstStatus: s2a, secondStatus: s2b, firstMarkdown: m2a, secondMarkdown: m2b });

        // 3. Markdown structures
        await autoTestLaunch("Create a compact JavaScript guide to sorting numbers. The answer MUST include a Markdown heading; a numbered list with at least three steps; a nested bullet list; a real Markdown table with a header row, separator row, and at least two data rows comparing ascending and descending order; a fenced JavaScript code block with at least three lines; at least two bold phrases and one italic phrase. Do not replace the table with plain text.");
        var s3 = await autoTestWaitFinished(autoTestState.controller, 150000);
        var m3 = window.lastExtractedMarkdown || "";
        var f3 = autoTestInspect(m3);
        autoTestRecord("3. Markdown structure preservation",
            m3.length > 0 && f3.headings > 0 && f3.orderedItems >= 3 &&
            f3.unorderedItems > 0 && f3.nestedItems > 0 &&
            f3.tableLines >= 4 && f3.tableSeparator &&
            f3.codeFences >= 2 && f3.boldMarkers >= 2,
            { status: s3, findings: f3, markdown: m3 });

        // 4a. Stop the extractor after actual streamed text is observed.
        await autoTestLaunch("Explain the difference between RAM and storage in a computer. Give a detailed explanation with examples.");
        var stoppedController = autoTestState.controller;
        var liveStatus = await autoTestWaitForLiveText(stoppedController, 45000);
        if (liveStatus.finished) {
            autoTestRecord("4a. Stop during live streaming", false, {
                reason: "The answer finished before a live text mutation could be stopped.",
                status: liveStatus
            });
        } else {
            stoppedController.stop();
            var stoppedStatus = stoppedController.status();
            autoTestRecord("4a. Stop during live streaming",
                !!stoppedStatus.finished && stoppedStatus.answerStreaming.characterMutations > 0,
                { status: stoppedStatus });
        }

        // 4b. Start a fresh run and ensure the old controller is stopped/replaced.
        await autoTestLaunch("Explain what a computer operating system does. Use a fresh answer and focus on its main responsibilities.");
        var restartedController = autoTestState.controller;
        var s4b = await autoTestWaitFinished(restartedController, 150000);
        var m4b = window.lastExtractedMarkdown || "";
        autoTestRecord("4b. Restart and fresh extraction",
            restartedController !== stoppedController &&
            !!stoppedController.status().finished &&
            !!s4b.finished &&
            m4b.length > 0 &&
            m4b.toLowerCase().indexOf("operating system") !== -1,
            { oldController: stoppedController.status(), newStatus: s4b, markdown: m4b });

        var passed = autoTestState.results.filter(function (item) { return item.pass; }).length;
        autoTestLog("COMPLETE: " + passed + "/" + autoTestState.results.length + " checks passed.");
        console.table(autoTestState.results.map(function (item) {
            return { test: item.test, result: item.pass ? "PASS" : "FAIL" };
        }));
        return autoTestState.results;
    } catch (error) {
        autoTestLog("ABORTED", String(error));
        throw error;
    } finally {
        autoTestState.running = false;
    }
};

var autoTestCancel = function () {
    autoTestState.cancelled = true;
    if (autoTestState.controller && !autoTestState.controller.status().finished) {
        autoTestState.controller.stop();
    }
    autoTestLog("Cancellation requested.");
};

window.__v10AutoTest = {
    state: autoTestState,
    run: autoTestRun,
    cancel: autoTestCancel,
    report: function () {
        console.table(autoTestState.results.map(function (item) {
            return { test: item.test, result: item.pass ? "PASS" : "FAIL" };
        }));
        return autoTestState.results;
    }
};

autoTestLog("Installed. Run: await window.__v10AutoTest.run()");
