import assert from "node:assert/strict";
import test from "node:test";

import { JournalRuntime } from "../src/journal-runtime.mjs";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class FakeJournal {
    constructor(events = []) {
        this.events = events;
        this.closed = false;
        this.closePromise = new Promise((resolve) => { this.resolveClose = resolve; });
    }
    getDirectory() { return "C:/Fake/Journal"; }
    async close() {
        this.closed = true;
        this.resolveClose();
    }
    async *[Symbol.asyncIterator]() {
        for (const event of this.events) yield event;
        await this.closePromise;
    }
}

test("starts at the live end and handles only yielded events", async () => {
    const optionsSeen = [];
    const eventsSeen = [];
    const journal = new FakeJournal([{ event: "DockingGranted", timestamp: "2026-01-01T00:00:00Z" }]);
    const runtime = new JournalRuntime({
        openJournal: async (options) => { optionsSeen.push(options); return journal; },
        onEvent: async (event) => eventsSeen.push(event.event),
        retryDelaysMs: [5]
    });
    runtime.start();
    await wait(15);
    assert.deepEqual(optionsSeen[0], { position: "end", watch: true });
    assert.deepEqual(eventsSeen, ["DockingGranted"]);
    assert.equal(runtime.getStatus().state, "watching");
    await runtime.stop();
    assert.equal(runtime.getStatus().state, "stopped");
});

test("retries missing directories and malformed watcher failures with bounded delay", async () => {
    let attempts = 0;
    const stableJournal = new FakeJournal();
    const runtime = new JournalRuntime({
        openJournal: async () => {
            attempts += 1;
            if (attempts === 1) throw new Error("Unable to find Elite Dangerous Journal directory");
            if (attempts === 2) throw new SyntaxError("Malformed journal line");
            return stableJournal;
        },
        onEvent: async () => {},
        retryDelaysMs: [5, 5]
    });
    runtime.start();
    await wait(30);
    assert.equal(attempts, 3);
    assert.equal(runtime.getStatus().state, "watching");
    await runtime.stop();
});
