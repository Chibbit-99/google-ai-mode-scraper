var prompt = "Explain quantum entanglement.";
var sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ==================================================
// STOP PREVIOUS RUN
// ==================================================

if (window.__aiModeExtractor) {
    window.__aiModeExtractor.stop();
}

// ==================================================
// STATE
// ==================================================

var finished = false;

var replyHeading = null;
var replySection = null;

var detectObserver = null;
var streamObserver = null;

var previousBlocks = new Map();
var markdownBlocks = new Map();

var lastContentMutation = Date.now();

var QUIET_PERIOD = 15000;
var TIMEOUT = 120000;

var completionTimer = null;
var timeoutTimer = null;

var completionText = "AI responses may include mistakes.";

var startedAt = performance.now();

window.lastExtractedMarkdown = "";

var mutationStats = {
    batches: 0,
    childList: 0,
    characterData: 0,
    attributes: 0,
    addedNodes: 0,
    removedNodes: 0,
    firstMutation: null,
    firstCharacterMutation: null,
    lastMutation: null
};

var blockStats = {
    discovered: 0,
    chunks: 0,
    edits: 0
};

var answerStreaming = {
    characterMutations: 0,
    characterMutationRecords: 0,
    coalescedCharacterRecords: 0,
    duplicateMutationGroups: 0,
    maxRecordsPerNode: 0,
    appendedCharacters: 0,
    replacedCharacters: 0,
    domInsertions: 0,
    firstAnswerMutation: null,
    lastAnswerMutation: null
};

var currentAnswerUnits = [];

var controller = {
    stop: function() {
        finished = true;

        if (detectObserver) detectObserver.disconnect();
        if (streamObserver) streamObserver.disconnect();

        clearInterval(completionTimer);
        clearTimeout(timeoutTimer);

        console.log("[STOPPED] Extractor stopped.");
    },

    status: function() {
        return {
            finished: finished,
            responseDetected: !!replySection,
            elapsed: elapsed(),
            mutations: mutationStats,
            blocks: blockStats,
            answerStreaming: answerStreaming,
            markdown: window.lastExtractedMarkdown || ""
        };
    }
};

window.__aiModeExtractor = controller;

console.log("[INIT] Preparing Markdown streaming observer v10...");

// ==================================================
// TIMING / LOGGING
// ==================================================

var elapsed = () => {
    return (performance.now() - startedAt).toFixed(1) + "ms";
};

var log = (label, ...args) => {
    console.log(
        "[" + elapsed() + "] [" + label + "]",
        ...args
    );
};

// ==================================================
// UTILITIES
// ==================================================

var normalizeText = text => (text || "")
    .replace(/\s+/g, " ")
    .trim();

var hasVisibleText = element =>
    normalizeText(element.innerText).length > 0;

// ==================================================
// COMPLETION FOOTER DETECTION
// ==================================================

var isCompletionBlock = node => {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
        return false;
    }

    var text = normalizeText(node.innerText || "");

    if (!text.includes(completionText)) {
        return false;
    }

    return text.length < 250;
};

// ==================================================
// CITATION FILTERING
// ==================================================

var isCitationWrapper = node => {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
        return false;
    }

    if (
        node.matches(
            'button[aria-label="Related results"]'
        )
    ) {
        return true;
    }

    if (
        node.tagName === "SPAN" &&
        node.querySelector(
            'button[aria-label="Related results"]'
        )
    ) {
        var clone = node.cloneNode(true);

        clone.querySelectorAll(
            'button[aria-label="Related results"]'
        ).forEach(el => el.remove());

        clone.querySelectorAll(
            '[aria-hidden="true"]'
        ).forEach(el => el.remove());

        return !normalizeText(clone.textContent);
    }

    return false;
};

// ==================================================
// IGNORED ELEMENTS
// ==================================================

var isIgnored = node => {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
        return false;
    }

    var tag = node.tagName.toLowerCase();

    if (
        node.hidden ||
        node.getAttribute("aria-hidden") === "true" ||
        [
            "script",
            "style",
            "svg",
            "noscript",
            "button"
        ].includes(tag)
    ) {
        return true;
    }

    if (
        node.matches(
            '[role="status"], [role="alert"]'
        )
    ) {
        return true;
    }

    if (isCompletionBlock(node)) return true;

    if (isCitationWrapper(node)) return true;

    return false;
};

// ==================================================
// ANSWER MUTATION CLASSIFICATION
// ==================================================

var getMutationElement = target => {
    if (!target) return null;

    if (target.nodeType === Node.ELEMENT_NODE) {
        return target;
    }

    return target.parentElement || null;
};

var isAnswerMutationTarget = target => {
    var element = getMutationElement(target);

    if (!element || !replySection) return false;

    if (!replySection.contains(element)) return false;

    if (
        element === replyHeading ||
        replyHeading.contains(element)
    ) {
        return false;
    }

    var current = element;

    while (
        current &&
        current !== replySection
    ) {
        if (isIgnored(current)) {
            return false;
        }

        current = current.parentElement;
    }

    return true;
};

var getContainingAnswerUnit = target => {
    var element = getMutationElement(target);

    if (!element) return null;

    return currentAnswerUnits.find(unit =>
        unit === element ||
        unit.contains(element)
    ) || null;
};

var isWithinAnswerUnit = target =>
    !!getContainingAnswerUnit(target);

var recordAnswerMutation = () => {
    var now = elapsed();

    if (!answerStreaming.firstAnswerMutation) {
        answerStreaming.firstAnswerMutation = now;
    }

    answerStreaming.lastAnswerMutation = now;
};

// ==================================================
// INLINE MARKDOWN SERIALIZATION
// ==================================================

var serializeInline = node => {
    if (node.nodeType === Node.TEXT_NODE) {
        return node.nodeValue || "";
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
        return "";
    }

    if (isIgnored(node)) return "";

    var tag = node.tagName.toLowerCase();

    if (tag === "br") return "\n";

    var content = [...node.childNodes]
        .map(serializeInline)
        .join("");

    if (!content.trim()) return content;

    if (["strong", "b"].includes(tag)) {
        return "**" + content + "**";
    }

    if (["em", "i"].includes(tag)) {
        return "*" + content + "*";
    }

    if (tag === "code") {
        return "`" + content + "`";
    }

    if (tag === "a") {
        return content;
    }

    if (tag === "sup") {
        return "^" + content;
    }

    if (tag === "sub") {
        return "~" + content;
    }

    return content;
};

// ==================================================
// HEADING DETECTION
// ==================================================

var getHeadingLevel = block => {
    var tag = block.tagName.toLowerCase();

    if (/^h[1-6]$/.test(tag)) {
        var level = Number(tag[1]);

        return level >= 3 ? 2 : level;
    }

    var ariaLevel = block.getAttribute("aria-level");

    if (
        block.getAttribute("role") === "heading" &&
        ariaLevel
    ) {
        var level = Number(ariaLevel);

        return level >= 3 ? 2 : level;
    }

    var style = getComputedStyle(block);

    var fontSize = parseFloat(style.fontSize);
    var fontWeight = parseInt(style.fontWeight, 10) || 400;
    var marginTop = parseFloat(style.marginTop) || 0;

    var text = normalizeText(block.innerText);

    if (
        text.length > 0 &&
        text.length < 85 &&
        fontWeight >= 600
    ) {
        if (fontSize >= 24) return 1;

        if (
            fontSize >= 20 ||
            (fontSize >= 18 && marginTop >= 16)
        ) {
            return 2;
        }
    }

    return 0;
};

// ==================================================
// LIST SERIALIZATION
// ==================================================

var serializeList = (list, depth) => {
    var ordered = list.tagName === "OL";
    var output = [];

    var start = Number(list.getAttribute("start")) || 1;

    [...list.children].forEach((item, index) => {
        if (item.tagName !== "LI") return;

        var contentNodes = [...item.childNodes].filter(node =>
            !(
                node.nodeType === Node.ELEMENT_NODE &&
                ["UL", "OL"].includes(node.tagName)
            )
        );

        var content = contentNodes
            .map(serializeInline)
            .join("")
            .trim();

        var number =
            Number(item.getAttribute("value")) ||
            start + index;

        var prefix = ordered
            ? number + ". "
            : "- ";

        var indent = "  ".repeat(depth);

        if (content) {
            output.push(indent + prefix + content);
        }

        [...item.children]
            .filter(child =>
                ["UL", "OL"].includes(child.tagName)
            )
            .forEach(nested => {
                var nestedMarkdown = serializeList(
                    nested,
                    depth + 1
                );

                if (nestedMarkdown) {
                    output.push(nestedMarkdown);
                }
            });
    });

    return output.join("\n");
};

// ==================================================
// TABLE AND CODE-BLOCK SERIALIZATION
// ==================================================

var serializeTable = table => {
    var rows = [...table.querySelectorAll("tr")].map(row =>
        [...row.children]
            .filter(cell => ["TH", "TD"].includes(cell.tagName))
            .map(cell => serializeInline(cell)
                .replace(/\\s*\\n\\s*/g, " ")
                .replace(/\\|/g, "\\\\|")
                .trim())
    ).filter(row => row.length);
    if (!rows.length) return "";
    var width = Math.max(...rows.map(row => row.length));
    rows = rows.map(row => { while (row.length < width) row.push(""); return row; });
    var header = rows[0];
    var separator = header.map(() => "---");
    return ["| " + header.join(" | ") + " |", "| " + separator.join(" | ") + " |"]
        .concat(rows.slice(1).map(row => "| " + row.join(" | ") + " |")).join("\\n");
};

var serializeCodeBlock = pre => {
    var code = pre.querySelector("code");
    var source = code || pre;
    var content = (source.innerText || source.textContent || "")
        .replace(/\\r\\n/g, "\\n").replace(/\\s+$/, "");
    if (!content.trim()) return "";
    var classes = ((pre.className || "") + " " + (code && code.className || "")).split(/\\s+/);
    var languageClass = classes.find(name => name.indexOf("language-") === 0 || name.indexOf("lang-") === 0) || "";
    var language = languageClass.replace(/^language-/, "").replace(/^lang-/, "");
    var fence = content.indexOf("````") !== -1 ? "`````" : "```";
    return fence + language + "\\n" + content + "\\n" + fence;
};
// ==================================================
// BLOCK SERIALIZATION
// ==================================================

var serializeBlock = block => {
    if (!block || isIgnored(block)) return "";

    if (block.matches("UL, OL")) return serializeList(block, 0);
    if (block.matches("TABLE")) return serializeTable(block);
    if (block.matches("PRE")) return serializeCodeBlock(block);

    var level = getHeadingLevel(block);

    var content = [...block.childNodes]
        .map(serializeInline)
        .join("")
        .trim();

    if (!content) return "";

    if (level) {
        return "#".repeat(level) + " " + content;
    }

    return content;
};

// ==================================================
// COLLECT CONTENT BLOCKS
// ==================================================

var collectUnits = container => {
    var units = [];

    var walk = node => {
        if (
            !node ||
            node.nodeType !== Node.ELEMENT_NODE ||
            isIgnored(node) ||
            node === replyHeading
        ) {
            return;
        }

        if (!hasVisibleText(node)) return;

        if (node.matches("UL, OL, TABLE, PRE")) {
            units.push(node);
            return;
        }

        var children = [...node.children].filter(child =>
            child !== replyHeading &&
            !isIgnored(child) &&
            hasVisibleText(child)
        );

        var structural = children.filter(child =>
            ["DIV", "UL", "OL", "TABLE", "PRE"].includes(child.tagName)
        );

        if (structural.length >= 2) {
            structural.forEach(walk);
            return;
        }

        if (
            structural.length === 1 &&
            children.length === 1
        ) {
            walk(structural[0]);
            return;
        }

        units.push(node);
    };

    [...container.children].forEach(walk);

    return units;
};

// ==================================================
// STREAMING TRACKING
// ==================================================

var processUnit = (element, markdown) => {
    markdown = (markdown || "").trim();

    if (!markdown) return;

    var previous = previousBlocks.get(element);

    if (previous === undefined) {
        previousBlocks.set(element, markdown);
        markdownBlocks.set(element, markdown);

        blockStats.discovered++;

        log("BLOCK", markdown);

        return;
    }

    if (markdown === previous) return;

    if (markdown.startsWith(previous)) {
        var addition = markdown.slice(previous.length);

        previousBlocks.set(element, markdown);
        markdownBlocks.set(element, markdown);

        if (addition) {
            blockStats.chunks++;

            log("MARKDOWN CHUNK", addition);
        }

        return;
    }

    previousBlocks.set(element, markdown);
    markdownBlocks.set(element, markdown);

    blockStats.edits++;

    log("EDIT", markdown);
};

var processAnswer = () => {
    if (!replySection || finished) return;

    currentAnswerUnits = collectUnits(replySection);

    currentAnswerUnits.forEach(element => {
        if (finished) return;

        var markdown = serializeBlock(element);

        if (markdown) {
            processUnit(element, markdown);
        }
    });
};

// ==================================================
// CHARACTER-LEVEL STREAMING DIAGNOSTICS
// ==================================================

var inspectCharacterMutation = (target, oldText, recordCount) => {
    if (
        !isAnswerMutationTarget(target) ||
        !isWithinAnswerUnit(target)
    ) {
        return;
    }

    var newText = target.nodeValue || "";
    oldText = oldText || "";

    if (oldText === newText) return;

    answerStreaming.characterMutations++;
    answerStreaming.characterMutationRecords += recordCount;
    answerStreaming.coalescedCharacterRecords += Math.max(0, recordCount - 1);

    if (recordCount > 1) {
        answerStreaming.duplicateMutationGroups++;
        answerStreaming.maxRecordsPerNode = Math.max(
            answerStreaming.maxRecordsPerNode,
            recordCount
        );

        log("DUPLICATE MUTATIONS COALESCED", {
            recordsForSameNode: recordCount,
            oldLength: oldText.length,
            finalLength: newText.length,
            netChange: newText.length - oldText.length,
            oldText: oldText,
            finalText: newText
        });
    }

    recordAnswerMutation();

    var isAppend = newText.startsWith(oldText);

    if (isAppend) {
        var addition = newText.slice(oldText.length);

        answerStreaming.appendedCharacters += addition.length;

        log("ANSWER TEXT APPEND", {
            added: addition,
            oldLength: oldText.length,
            newLength: newText.length,
            delta: addition.length,
            coalescedRecords: recordCount
        });
    } else {
        answerStreaming.replacedCharacters += newText.length;

        log("ANSWER TEXT REPLACEMENT", {
            oldText: oldText,
            newText: newText,
            oldLength: oldText.length,
            newLength: newText.length,
            coalescedRecords: recordCount
        });
    }
};

var inspectChildListMutation = mutation => {
    if (
        !isAnswerMutationTarget(mutation.target) ||
        !isWithinAnswerUnit(mutation.target)
    ) {
        return;
    }

    var addedText = [...mutation.addedNodes]
        .filter(node =>
            node.nodeType === Node.TEXT_NODE
        )
        .map(node => node.nodeValue || "")
        .join("");

    if (!addedText.trim()) return;

    answerStreaming.domInsertions++;

    recordAnswerMutation();

    log("ANSWER DOM INSERTION", {
        text: addedText,
        length: addedText.length,
        target: getMutationElement(mutation.target)
    });
};

// ==================================================
// FINAL MARKDOWN RECONSTRUCTION
// ==================================================

var buildFinalMarkdown = () => {
    if (!replySection) return "";

    var units = collectUnits(replySection);

    var current = units
        .map(element => {
            var markdown = serializeBlock(element);

            if (!markdown) {
                markdown = markdownBlocks.get(element) || "";
            }

            return markdown.trim();
        })
        .filter(Boolean);

    if (!current.length && markdownBlocks.size) {
        console.warn(
            "[FINAL] Reconstructing from captured streaming blocks."
        );

        current = [...markdownBlocks.values()]
            .filter(Boolean);
    }

    return current.join("\n\n");
};

// ==================================================
// COMPLETION
// ==================================================

var completeAnswer = reason => {
    if (finished) return;

    processAnswer();

    finished = true;

    if (detectObserver) detectObserver.disconnect();
    if (streamObserver) streamObserver.disconnect();

    clearInterval(completionTimer);
    clearTimeout(timeoutTimer);

    var finalMarkdown = buildFinalMarkdown();

    window.lastExtractedMarkdown = finalMarkdown;

    log("COMPLETE", reason);

    log("FINAL BLOCK COUNT",
        finalMarkdown
            ? finalMarkdown.split(/\n\n+/).length
            : 0
    );

    log("STREAMING STATISTICS", {
        blocks: blockStats,
        mutations: mutationStats,
        answerStreaming: answerStreaming,
        elapsed: elapsed()
    });

    console.log(
        "%c[FINAL MARKDOWN]",
        "font-weight:bold;font-size:16px"
    );

    console.log(finalMarkdown);
};

// ==================================================
// DETECT NEW RESPONSE HEADING
// ==================================================

var oldHeadings = new Set(
    document.querySelectorAll("h3")
);

var expectedHeading =
    "AI Mode reply for " + normalizeText(prompt);

var findNewReplyHeading = () => {
    return [...document.querySelectorAll("h3")]
        .filter(el =>
            !oldHeadings.has(el) &&
            normalizeText(el.innerText) === expectedHeading
        )
        .at(-1) || null;
};

// ==================================================
// DETECT RESPONSE BOUNDARY
// ==================================================

detectObserver = new MutationObserver(() => {
    if (replySection || finished) return;

    var candidateHeading = findNewReplyHeading();

    if (!candidateHeading) return;

    // Preserve the empirically validated v5.6 boundary.
    var candidateSection = candidateHeading.parentElement;

    if (
        !candidateSection ||
        candidateSection.children.length < 2
    ) {
        return;
    }

    replyHeading = candidateHeading;
    replySection = candidateSection;

    log("DETECTED", replyHeading.innerText);
    log("BOUNDARY", replySection);

    log(
        "BOUNDARY CHILDREN",
        [...replySection.children].map(el => ({
            tag: el.tagName,
            text: normalizeText(el.innerText).slice(0, 100)
        }))
    );

    log(
        "INITIAL BOUNDARY STATE",
        {
            completeAttribute: replySection.getAttribute("data-complete"),
            textLength: (replySection.innerText || "").length
        }
    );

    detectObserver.disconnect();

    var firstMutationLogged = false;

    streamObserver = new MutationObserver(mutations => {
        if (finished) return;

        mutationStats.batches++;

        var batch = {
            childList: 0,
            characterData: 0,
            attributes: 0,
            addedNodes: 0,
            removedNodes: 0
        };

        // Refresh the answer-unit snapshot before classifying this batch.
        processAnswer();

        var characterChanges = new Map();

        mutations.forEach(mutation => {
            if (mutation.type === "childList") {
                batch.childList++;

                batch.addedNodes += mutation.addedNodes.length;
                batch.removedNodes += mutation.removedNodes.length;

                mutationStats.childList++;
                mutationStats.addedNodes += mutation.addedNodes.length;
                mutationStats.removedNodes += mutation.removedNodes.length;

                inspectChildListMutation(mutation);
            }

            if (mutation.type === "characterData") {
                batch.characterData++;

                mutationStats.characterData++;

                if (!mutationStats.firstCharacterMutation) {
                    mutationStats.firstCharacterMutation = elapsed();

                    log(
                        "FIRST CHARACTER MUTATION",
                        {
                            target: mutation.target.parentElement,
                            newText: mutation.target.nodeValue
                        }
                    );
                }

                var existingChange = characterChanges.get(mutation.target);

                if (!existingChange) {
                    characterChanges.set(mutation.target, {
                        oldText: mutation.oldValue || "",
                        records: 1
                    });
                } else {
                    existingChange.records++;
                }
            }

            if (mutation.type === "attributes") {
                batch.attributes++;

                mutationStats.attributes++;
            }
        });

        mutationStats.lastMutation = elapsed();

        if (!mutationStats.firstMutation) {
            mutationStats.firstMutation = elapsed();
        }

        if (!firstMutationLogged) {
            firstMutationLogged = true;

            log("FIRST RESPONSE MUTATION", batch);
        }

        // Each text node is evaluated once per observer batch. MutationObserver
        // supplies each record's oldValue but only the final current nodeValue.
        // Coalescing avoids duplicate and misleading intermediate-delta reports.
        characterChanges.forEach((change, target) => {
            inspectCharacterMutation(
                target,
                change.oldText,
                change.records
            );
        });

        lastContentMutation = Date.now();

        if (
            replySection.innerText.includes(completionText)
        ) {
            completeAnswer(
                "[COMPLETE] Explicit completion marker."
            );
        }
    });

    streamObserver.observe(replySection, {
        subtree: true,
        childList: true,
        characterData: true,
        characterDataOldValue: true,
        attributes: true,
        attributeFilter: [
            "class",
            "style",
            "hidden"
        ]
    });

    log("OBSERVER", "Attached to validated response boundary.");

    processAnswer();
});

// ==================================================
// START OBSERVING BEFORE SUBMISSION
// ==================================================

detectObserver.observe(document.body, {
    subtree: true,
    childList: true
});

// ==================================================
// SUBMIT PROMPT
// ==================================================

var box = document.querySelector(
    'textarea[aria-label="Ask anything"]'
);

if (!box) {
    controller.stop();

    throw new Error("Textarea not found.");
}

var setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value"
).set;

setter.call(box, prompt);

box.dispatchEvent(new Event("input", {
    bubbles: true
}));

var send;

for (var i = 0; i < 100; i++) {
    send = [...document.querySelectorAll(
        'button[aria-label="Send"]'
    )].find(button =>
        !button.disabled &&
        button.getClientRects().length > 0
    );

    if (send) break;

    await sleep(100);
}

if (!send) {
    controller.stop();

    throw new Error("Send button not found.");
}

send.click();

log("SENT", "Waiting for streamed response...");

// ==================================================
// QUIET-PERIOD FALLBACK
// ==================================================

completionTimer = setInterval(() => {
    if (finished || !replySection) return;

    var quietFor = Date.now() - lastContentMutation;

    if (quietFor < QUIET_PERIOD) return;

    var generating = [
        'button[aria-label*="Stop"]',
        'button[aria-label*="stop"]',
        '[data-testid*="stop"]'
    ].some(selector =>
        [...document.querySelectorAll(selector)].some(el =>
            el.getClientRects().length > 0
        )
    );

    if (generating) return;

    completeAnswer(
        "[COMPLETE] Quiet-period fallback."
    );
}, 500);

// ==================================================
// TIMEOUT
// ==================================================

timeoutTimer = setTimeout(() => {
    if (finished) return;

    completeAnswer(
        "[TIMEOUT] Partial response captured."
    );
}, TIMEOUT);

log("READY", "v10 is running.");
