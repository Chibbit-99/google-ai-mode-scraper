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

var controller = {
    stop: function() {
        finished = true;

        if (detectObserver) detectObserver.disconnect();
        if (streamObserver) streamObserver.disconnect();

        clearInterval(completionTimer);
        clearTimeout(timeoutTimer);

        console.log("[STOPPED] Extractor stopped.");
    }
};

window.__aiModeExtractor = controller;

console.log("[INIT] Preparing Markdown streaming observer v5.6...");

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

    // Only exclude small elements that are actually the
    // completion footer. Never exclude a large answer
    // container just because it contains the footer.

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

    // Preserve visible link text, but not its URL.
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
// BLOCK SERIALIZATION
// ==================================================

var serializeBlock = block => {
    if (!block || isIgnored(block)) return "";

    if (block.matches("UL, OL")) {
        return serializeList(block, 0);
    }

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

        // Lists stay together as individual Markdown units.
        if (node.matches("UL, OL")) {
            units.push(node);
            return;
        }

        var children = [...node.children].filter(child =>
            child !== replyHeading &&
            !isIgnored(child) &&
            hasVisibleText(child)
        );

        var structural = children.filter(child =>
            ["DIV", "UL", "OL"].includes(child.tagName)
        );

        // Multiple structural children: recurse into them.
        if (structural.length >= 2) {
            structural.forEach(walk);
            return;
        }

        // Single structural child: unwrap the wrapper.
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

        console.log("[BLOCK]", markdown);

        return;
    }

    if (markdown === previous) return;

    if (markdown.startsWith(previous)) {
        var addition = markdown.slice(previous.length);

        previousBlocks.set(element, markdown);
        markdownBlocks.set(element, markdown);

        if (addition) {
            console.log("[MARKDOWN CHUNK]", addition);
        }

        return;
    }

    previousBlocks.set(element, markdown);
    markdownBlocks.set(element, markdown);

    console.log("[EDIT]", markdown);
};

var processAnswer = () => {
    if (!replySection || finished) return;

    var units = collectUnits(replySection);

    units.forEach(element => {
        if (finished) return;

        var markdown = serializeBlock(element);

        if (markdown) {
            processUnit(element, markdown);
        }
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

    // If the DOM traversal unexpectedly misses everything,
    // recover the blocks already captured during streaming.
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

    console.log(reason);

    console.log(
        "[FINAL BLOCK COUNT]",
        finalMarkdown
            ? finalMarkdown.split(/\n\n+/).length
            : 0
    );

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

    // Confirmed from the inspected DOM:
    // the heading's immediate parent is DIV.Zkbeff.
    var candidateSection = candidateHeading.parentElement;

    if (
        !candidateSection ||
        candidateSection.children.length < 2
    ) {
        return;
    }

    replyHeading = candidateHeading;
    replySection = candidateSection;

    console.log("[DETECTED]", replyHeading.innerText);
    console.log("[BOUNDARY]", replySection);

    console.log(
        "[BOUNDARY CHILDREN]",
        [...replySection.children].map(el => ({
            tag: el.tagName,
            text: normalizeText(el.innerText).slice(0, 100)
        }))
    );

    detectObserver.disconnect();

    streamObserver = new MutationObserver(() => {
        if (finished) return;

        processAnswer();

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
        attributes: true,
        attributeFilter: [
            "class",
            "style",
            "hidden"
        ]
    });

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

console.log("[SENT] Waiting for streamed response...");

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

