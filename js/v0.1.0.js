async function sendPrompt(text) {
    // Find the input box
    const box = document.querySelector(
        'textarea[aria-label="Ask anything"]'
    );

    if (!box) {
        throw new Error("Input box not found.");
    }

    // Focus the input
    box.focus();

    // Set the textarea value using its native setter
    const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
    ).set;

    setter.call(box, text);

    // Notify Google's event listeners
    box.dispatchEvent(new Event("input", {
        bubbles: true
    }));

    // Wait for the Send button to become available
    for (let i = 0; i < 50; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));

        const button = [...document.querySelectorAll(
            'button[aria-label="Send"]'
        )].find(b =>
            !b.disabled &&
            b.getClientRects().length > 0
        );

        if (button) {
            button.click();
            return true;
        }
    }

    throw new Error("Send button not found or unavailable.");
}

