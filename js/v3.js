var prompt = "Explain quantum entanglement.";
var sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

var replySection = null;
var replyHeading = null;
var contentRoot = null;

var detectObserver = null;
var streamObserver = null;

var finished = false;

var previousBlocks = new Map();
var markdownBlocks = new Map();

console.log("[INIT] Preparing Markdown streaming observer...");

// --------------------------------------------------
// FIND ANSWER CONTAINER
// --------------------------------------------------

var findContentRoot = () => {
    if (!replySection) return null;

    var candidates = [...replySection.querySelectorAll("div")];

    var best = null;
    var bestScore = -1;

    candidates.forEach(el => {
        var children = [...el.children];

        if (children.length < 10) return;

        var meaningful = children.filter(child =>
            (child.innerText || "").trim().length > 0
        );

        if (meaningful.length < 5) return;

        var blockCount = children.filter(child =>
            ["DIV", "UL", "OL"].includes(child.tagName)
        ).length;

        if (blockCount < 5) return;

        var textLength = (el.innerText || "").trim().length;

        if (textLength < 100) return;

        var score = blockCount * 100 + meaningful.length;

        if (score > bestScore) {
            best = el;
            bestScore = score;
        }
    });

    return best;
};

// --------------------------------------------------
// INLINE MARKDOWN SERIALIZATION
// --------------------------------------------------

var serializeInline = node => {
    if (node.nodeType === Node.TEXT_NODE) {
        return node.nodeValue || "";
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
        return "";
    }

    var tag = node.tagName.toLowerCase();

    if (
        node.hidden ||
        node.getAttribute("aria-hidden") === "true" ||
        ["button", "script", "style", "svg"].includes(tag)
    ) {
        return "";
    }

    if (tag === "br") return "\n";

    var content = [...node.childNodes]
        .map(serializeInline)
        .join("");

    if (!content.trim()) return content;

    if (tag === "strong" || tag === "b") {
        return "**" + content.trim() + "**";
    }

    if (tag === "em" || tag === "i") {
        return "*" + content.trim() + "*";
    }

    if (tag === "code") {
        return "`" + content.trim() + "`";
    }

    if (tag === "a") {
        var href = node.href;

        if (href && href.startsWith("http")) {
            return "[" + content.trim() + "](" + href + ")";
        }
    }

    if (tag === "sup") {
        return "^" + content.trim();
    }

    if (tag === "sub") {
        return "~" + content.trim();
    }

    return content;
};

// --------------------------------------------------
// HEADING DETECTION
// --------------------------------------------------

var getHeadingLevel = block => {
    var tag = block.tagName.toLowerCase();

    // Genuine HTML headings.
    if (/^h[1-6]$/.test(tag)) {
        var htmlLevel = Number(tag[1]);

        return htmlLevel >= 3 ? 2 : htmlLevel;
    }

    // ARIA headings.
    var ariaLevel = block.getAttribute("aria-level");

    if (
        block.getAttribute("role") === "heading" &&
        ariaLevel
    ) {
        var level = Number(ariaLevel);

        return level >= 3 ? 2 : level;
    }

    // Google often renders headings as styled DIVs.
    var style = getComputedStyle(block);
    var fontSize = parseFloat(style.fontSize);
    var fontWeight = parseInt(style.fontWeight, 10) || 400;

    var text = (block.innerText || "").trim();

    if (
        text.length > 0 &&
        text.length < 100 &&
        fontSize >= 18 &&
        fontWeight >= 600
    ) {
        return fontSize >= 24 ? 1 : 2;
    }

    return 0;
};

// --------------------------------------------------
// LIST SERIALIZATION
// --------------------------------------------------

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

        var itemNumber = Number(item.getAttribute("value")) ||
            (start + index);

        var prefix = ordered
            ? itemNumber + ". "
            : "- ";

        var indent = "  ".repeat(depth);

        if (content) {
            output.push(indent + prefix + content);
        }

        // Nested lists.
        [...item.children]
            .filter(child => ["UL", "OL"].includes(child.tagName))
            .forEach(nested => {
                output.push(serializeList(nested, depth + 1));
            });
    });

    return output.join("\n");
};

// --------------------------------------------------
// COMPLETE BLOCK SERIALIZATION
// --------------------------------------------------

var serializeBlock = block => {
    var text = (block.innerText || "").trim();

    if (!text) return "";

    // Lists.
    if (block.matches("UL, OL")) {
        return serializeList(block, 0);
    }

    // Headings.
    var headingLevel = getHeadingLevel(block);

    var content = [...block.childNodes]
        .map(serializeInline)
        .join("")
        .trim();

    if (!content) {
        content = serializeInline(block).trim();
    }

    if (!content) return "";

    if (headingLevel) {
        return "#".repeat(headingLevel) + " " + content;
    }

    return content;
};

// --------------------------------------------------
// STREAMING BLOCK TRACKING
// --------------------------------------------------

var processUnit = (key, markdown, label) => {
    markdown = (markdown || "").trim();

    if (!markdown) return;

    var previous = previousBlocks.get(key);

    // First appearance.
    if (previous === undefined) {
        previousBlocks.set(key, markdown);
        markdownBlocks.set(key, markdown);

        console.log(label, markdown);
        return;
    }

    // Unchanged.
    if (markdown === previous) return;

    // Newly appended text.
    if (markdown.startsWith(previous)) {
        var addition = markdown.slice(previous.length);

        previousBlocks.set(key, markdown);
        markdownBlocks.set(key, markdown);

        if (addition) {
            console.log("[MARKDOWN CHUNK]", addition);
        }

        return;
    }

    // Existing text was edited or replaced.
    previousBlocks.set(key, markdown);
    markdownBlocks.set(key, markdown);

    console.log("[EDIT]", markdown);
};

// --------------------------------------------------
// FINAL MARKDOWN RECONSTRUCTION
// --------------------------------------------------

var buildFinalMarkdown = () => {
    var entries = [...markdownBlocks.entries()];

    entries.sort((a, b) => {
        var partsA = a[0].split(":").map(Number);
        var partsB = b[0].split(":").map(Number);

        var blockA = partsA[1];
        var blockB = partsB[1];

        if (blockA !== blockB) {
            return blockA - blockB;
        }

        var itemA = partsA[3] || 0;
        var itemB = partsB[3] || 0;

        return itemA - itemB;
    });

    return entries
        .map(entry => entry[1])
        .filter(Boolean)
        .join("\n\n");
};

// --------------------------------------------------
// PROCESS ANSWER
// --------------------------------------------------

var processAnswer = () => {
    if (!contentRoot || finished) return;

    var blocks = [...contentRoot.children];

    blocks.forEach((block, index) => {
        if (finished) return;

        var text = (block.innerText || "").trim();

        if (!text) return;

        // Completion marker.
        if (text.includes("AI responses may include mistakes.")) {
            finished = true;

            streamObserver.disconnect();

            console.log("[COMPLETE]");

            var finalMarkdown = buildFinalMarkdown();

            console.log(
                "%c[FINAL MARKDOWN]",
                "font-weight:bold;font-size:16px"
            );

            console.log(finalMarkdown);

            // Keep the result accessible in DevTools.
            window.lastExtractedMarkdown = finalMarkdown;

            return;
        }

        // Ignore interface elements.
        if (
            block.matches(
                'button, [aria-live], [role="status"], [role="alert"]'
            ) ||
            block.closest(
                '[aria-live], [role="status"], [role="alert"]'
            )
        ) return;

        // Lists: process individual list items.
        if (block.matches("UL, OL")) {
            [...block.children].forEach((item, itemIndex) => {
                if (!item.matches("LI")) return;

                var content = [...item.childNodes]
                    .filter(node =>
                        !(
                            node.nodeType === Node.ELEMENT_NODE &&
                            ["UL", "OL"].includes(node.tagName)
                        )
                    )
                    .map(serializeInline)
                    .join("")
                    .trim();

                var prefix = block.tagName === "OL"
                    ? (
                        Number(item.getAttribute("value")) ||
                        (
                            (Number(block.getAttribute("start")) || 1) +
                            itemIndex
                        )
                    ) + ". "
                    : "- ";

                var markdown = prefix + content;

                processUnit(
                    "block:" + index + ":item:" + itemIndex,
                    markdown,
                    "[LIST ITEM]"
                );

                // Nested lists.
                [...item.children]
                    .filter(child =>
                        ["UL", "OL"].includes(child.tagName)
                    )
                    .forEach((nested, nestedIndex) => {
                        processUnit(
                            "block:" + index +
                            ":nested:" + itemIndex +
                            ":" + nestedIndex,
                            serializeList(nested, 1),
                            "[NESTED LIST]"
                        );
                    });
            });

            return;
        }

        // Ordinary paragraph or heading.
        var markdown = serializeBlock(block);
        var headingLevel = getHeadingLevel(block);

        processUnit(
            "block:" + index,
            markdown,
            headingLevel ? "[HEADING]" : "[PARAGRAPH]"
        );
    });
};

// --------------------------------------------------
// DETECT NEW AI MODE RESPONSE
// --------------------------------------------------

var oldHeadings = new Set(document.querySelectorAll("h3"));

detectObserver = new MutationObserver(() => {
    if (replySection) return;

    replyHeading = [...document.querySelectorAll("h3")].find(el =>
        !oldHeadings.has(el) &&
        el.innerText.includes("AI Mode reply for")
    );

    if (!replyHeading) return;

    console.log("[DETECTED]", replyHeading.innerText);

    var current = replyHeading.parentElement;

    while (current && current !== document.body) {
        if (current.children.length >= 5) {
            replySection = current;
            break;
        }

        current = current.parentElement;
    }

    if (!replySection) {
        console.error("[ERROR] Reply section not found.");
        return;
    }

    console.log("[BOUNDARY]", replySection);

    detectObserver.disconnect();

    // Wait for the actual answer container.
    streamObserver = new MutationObserver(() => {
        if (!contentRoot) {
            var candidate = findContentRoot();

            if (candidate) {
                contentRoot = candidate;

                console.log("[CONTENT ROOT LOCKED]", contentRoot);
                console.log("[BLOCK COUNT]", contentRoot.children.length);

                // Lock the root permanently.
                streamObserver.disconnect();

                streamObserver = new MutationObserver(() => {
                    processAnswer();
                });

                streamObserver.observe(contentRoot, {
                    subtree: true,
                    childList: true,
                    characterData: true
                });

                processAnswer();

                return;
            }
        }

        processAnswer();
    });

    streamObserver.observe(replySection, {
        subtree: true,
        childList: true,
        characterData: true
    });
});

// --------------------------------------------------
// START OBSERVING
// --------------------------------------------------

detectObserver.observe(document.body, {
    subtree: true,
    childList: true
});

// --------------------------------------------------
// SUBMIT PROMPT
// --------------------------------------------------

var box = document.querySelector(
    'textarea[aria-label="Ask anything"]'
);

if (!box) {
    detectObserver.disconnect();
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

// Wait for Send.
var send;

for (var i = 0; i < 100; i++) {
    send = [...document.querySelectorAll(
        'button[aria-label="Send"]'
    )].find(b =>
        !b.disabled && b.getClientRects().length > 0
    );

    if (send) break;

    await sleep(100);
}

if (!send) {
    detectObserver.disconnect();
    throw new Error("Send button not found.");
}

send.click();

console.log("[SENT] Waiting for streamed response...");

// --------------------------------------------------
// TIMEOUT
// --------------------------------------------------

setTimeout(() => {
    detectObserver.disconnect();
    streamObserver?.disconnect();

    if (!finished) {
        console.warn("[TIMEOUT] Observer stopped.");

        // Still expose whatever was captured.
        window.lastExtractedMarkdown = buildFinalMarkdown();

        console.log("[PARTIAL MARKDOWN]");
        console.log(window.lastExtractedMarkdown);
    }
}, 60000);

