// ==================================================
// v9 TEST — DUPLICATE MUTATION COALESCING
// ==================================================
// Standalone DevTools test. Does NOT submit a prompt or modify the extractor.
// It creates several characterData MutationRecords for the same text nodes
// within one observer batch, then applies the exact v8 coalescing strategy:
// earliest oldValue + final nodeValue = one aggregate evaluation per node.
//
// Expected:
// - 8 raw MutationRecords
// - 4 unique text nodes evaluated
// - 4 records coalesced away
// - 3 meaningful aggregate changes emitted
// - 1 net-zero node change ignored
// - No duplicate/intermediate deltas

if (window.__v9MutationTest) {
    window.__v9MutationTest.stop();
}

var v9TestFinished = false;
var v9TestObserver = null;
var v9TestFixture = document.createElement("div");
var v9TestStartedAt = performance.now();

v9TestFixture.id = "__v9_mutation_coalescing_test__";
v9TestFixture.style.cssText =
    "position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;overflow:hidden;";

var v9TestNodes = {
    append: document.createTextNode("A"),
    replacement: document.createTextNode("abcdef"),
    netZero: document.createTextNode("stable"),
    single: document.createTextNode("x")
};

Object.keys(v9TestNodes).forEach(key => {
    var span = document.createElement("span");
    span.appendChild(v9TestNodes[key]);
    v9TestFixture.appendChild(span);
});

document.body.appendChild(v9TestFixture);

var v9TestResults = {
    rawMutationRecords: 0,
    uniqueTextNodes: 0,
    coalescedRecords: 0,
    emittedChanges: [],
    ignoredNetZeroChanges: 0,
    batches: 0,
    passed: false
};

var v9TestLog = (label, data) => {
    console.log(
        "[v9 TEST " + (performance.now() - v9TestStartedAt).toFixed(1) + "ms] " + label,
        data === undefined ? "" : data
    );
};

var v9TestCleanup = () => {
    if (v9TestObserver) v9TestObserver.disconnect();
    if (v9TestFixture && v9TestFixture.isConnected) {
        v9TestFixture.remove();
    }
};

var v9TestController = {
    stop: function() {
        v9TestFinished = true;
        v9TestCleanup();
        console.log("[v9 TEST] Stopped and cleaned up.");
    },
    status: function() {
        return v9TestResults;
    }
};

window.__v9MutationTest = v9TestController;

v9TestObserver = new MutationObserver(mutations => {
    if (v9TestFinished) return;

    v9TestResults.batches++;

    var characterChanges = new Map();

    mutations.forEach(mutation => {
        if (mutation.type !== "characterData") return;

        v9TestResults.rawMutationRecords++;

        var existingChange = characterChanges.get(mutation.target);

        if (!existingChange) {
            characterChanges.set(mutation.target, {
                oldText: mutation.oldValue || "",
                records: 1
            });
        } else {
            existingChange.records++;
        }
    });

    // Same aggregation approach used by v8.js:
    // first oldValue, final target.nodeValue, once per text node.
    characterChanges.forEach((change, target) => {
        v9TestResults.uniqueTextNodes++;
        v9TestResults.coalescedRecords += Math.max(0, change.records - 1);

        var newText = target.nodeValue || "";
        var oldText = change.oldText || "";

        if (oldText === newText) {
            v9TestResults.ignoredNetZeroChanges++;
            v9TestLog("NET-ZERO CHANGE IGNORED", {
                oldText: oldText,
                finalText: newText,
                records: change.records
            });
            return;
        }

        var result = {
            oldText: oldText,
            newText: newText,
            records: change.records,
            type: newText.startsWith(oldText) ? "append" : "replacement",
            delta: newText.startsWith(oldText)
                ? newText.slice(oldText.length)
                : null
        };

        v9TestResults.emittedChanges.push(result);
        v9TestLog("COALESCED NODE CHANGE", result);
    });

    var appendResult = v9TestResults.emittedChanges.find(item =>
        item.oldText === "A"
    );
    var replacementResult = v9TestResults.emittedChanges.find(item =>
        item.oldText === "abcdef"
    );
    var singleResult = v9TestResults.emittedChanges.find(item =>
        item.oldText === "x"
    );

    var assertions = {
        oneObserverBatch: v9TestResults.batches === 1,
        expectedRawRecords: v9TestResults.rawMutationRecords === 8,
        expectedUniqueNodes: v9TestResults.uniqueTextNodes === 4,
        expectedCoalescedRecords: v9TestResults.coalescedRecords === 4,
        appendAggregatedOnce:
            !!appendResult &&
            appendResult.newText === "ABCD" &&
            appendResult.delta === "BCD" &&
            appendResult.records === 3,
        replacementAggregatedOnce:
            !!replacementResult &&
            replacementResult.newText === "abcXYZ" &&
            replacementResult.type === "replacement" &&
            replacementResult.records === 2,
        singleMutationPreserved:
            !!singleResult &&
            singleResult.newText === "xy" &&
            singleResult.delta === "y" &&
            singleResult.records === 1,
        netZeroIgnored:
            v9TestResults.ignoredNetZeroChanges === 1 &&
            !v9TestResults.emittedChanges.some(item =>
                item.oldText === "stable"
            ),
        exactlyThreeEmittedChanges:
            v9TestResults.emittedChanges.length === 3
    };

    v9TestResults.assertions = assertions;
    v9TestResults.passed = Object.values(assertions).every(Boolean);

    v9TestLog(
        v9TestResults.passed ? "PASS" : "FAIL",
        {
            assertions: assertions,
            totals: {
                rawMutationRecords: v9TestResults.rawMutationRecords,
                uniqueTextNodes: v9TestResults.uniqueTextNodes,
                coalescedRecords: v9TestResults.coalescedRecords,
                emittedChanges: v9TestResults.emittedChanges.length,
                ignoredNetZeroChanges: v9TestResults.ignoredNetZeroChanges
            }
        }
    );

    v9TestCleanup();
});

v9TestObserver.observe(v9TestFixture, {
    subtree: true,
    characterData: true,
    characterDataOldValue: true
});

v9TestLog("START", "Generating multiple changes to the same text nodes in one synchronous batch.");

// Three records on the same node: A -> AB -> ABC -> ABCD.
// The test must report one aggregate append: A -> ABCD.
v9TestNodes.append.data = "AB";
v9TestNodes.append.data = "ABC";
v9TestNodes.append.data = "ABCD";

// Two records on the same node, ending in a replacement.
// Must report one aggregate replacement: abcdef -> abcXYZ.
v9TestNodes.replacement.data = "abc";
v9TestNodes.replacement.data = "abcXYZ";

// Two records that return to the original value.
// Must be counted as coalesced, but emit no false change.
v9TestNodes.netZero.data = "temporary";
v9TestNodes.netZero.data = "stable";

// Control: one ordinary mutation must remain one ordinary append.
v9TestNodes.single.data = "xy";

v9TestLog("MUTATIONS QUEUED", "Waiting for the MutationObserver batch...");
