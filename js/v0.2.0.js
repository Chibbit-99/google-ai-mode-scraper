async function automate(prompt) {
    const delay = ms => new Promise(r => setTimeout(r, ms));
    const marker = "AI responses may include mistakes.";

    // 1. Locate input
    const box = document.querySelector(
        'textarea[aria-label="Ask anything"]'
    );

    if (!box) throw new Error("Input box not found.");

    // 2. Type prompt
    box.focus();

    const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
    ).set;

    setter.call(box, prompt);

    box.dispatchEvent(new Event("input", {
        bubbles: true
    }));

    // 3. Wait for Send button
    let sendButton;

    for (let i = 0; i < 50; i++) {
        sendButton = [...document.querySelectorAll(
            'button[aria-label="Send"]'
        )].find(b => !b.disabled && b.getClientRects().length);

        if (sendButton) break;

        await delay(100);
    }

    if (!sendButton) throw new Error("Send button unavailable.");

    // Snapshot existing responses
    const getDisclaimerCount = () =>
        [...document.querySelectorAll("div")].filter(el =>
            el.innerText?.length <= 100 &&
            el.innerText?.includes(marker)
        ).length;

    const previousCount = getDisclaimerCount();

    const getLatestResponse = () => {
        const matches = [...document.querySelectorAll("div")]
            .filter(el =>
                el.innerText?.length <= 100 &&
                el.innerText?.includes(marker)
            );

        if (!matches.length) return null;

        // Latest disclaimer in document order
        let current = matches[matches.length - 1];

        // Find its response container
        while (current) {
            const text = current.innerText || "";

            if (text.includes(marker) && text.length > 100) {
                return text
                    .replace(
                        /AI responses may include mistakes\.\s*Learn more/g,
                        ""
                    )
                    .trim();
            }

            current = current.parentElement;
        }

        return null;
    };

    // 4. Send prompt
    sendButton.click();

    // 5. Wait for a new response and DOM stability
    let lastResponse = null;
    let stableSince = null;
    const timeout = Date.now() + 120000;

    while (Date.now() < timeout) {
        await delay(500);

        const response = getLatestResponse();
        const newResponse = getDisclaimerCount() > previousCount;

        if (!response || (!newResponse && response === lastResponse)) {
            continue;
        }

        if (response !== lastResponse) {
            lastResponse = response;
            stableSince = Date.now();
        }

        // Check whether Gemini is still generating
        const generating = [...document.querySelectorAll(
            'button[aria-label="Stop"]'
        )].some(b => b.getClientRects().length > 0);

        // Response must remain unchanged for 2.5 seconds
        if (
            newResponse &&
            stableSince &&
            Date.now() - stableSince >= 2500 &&
            !generating
        ) {
            return lastResponse;
        }
    }

    throw new Error("Timed out waiting for Gemini's response.");
}

