"use strict";

// A visualizer that makes app::Counter take a minute to display, for the evaluation timeout test.

class SlowCounter {
    toString() {
        let start = Date.now();
        while (Date.now() - start < 60000) {
            // spin
        }
        return "slow";
    }
}

function initializeScript() {
    return [new host.apiVersionSupport(1, 3), new host.typeSignatureRegistration(SlowCounter, "app::Counter")];
}
