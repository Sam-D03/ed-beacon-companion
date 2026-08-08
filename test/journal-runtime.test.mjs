import assert from "node:assert/strict";
import test from "node:test";

import { JournalRuntime } from "../src/journal-runtime.mjs";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class FakeJournal {
    constructor(events = [], { statuses = [], statusError = null, statusErrorOnClose = null } = {}) {
        this.events = events;
        this.statuses = statuses;
        this.statusError = statusError;
        this.statusErrorOnClose = statusErrorOnClose;
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
    async *watchStatus() {
        try {
            for (const status of this.statuses) yield status;
            if (this.statusError) throw this.statusError;
            await this.closePromise;
        } finally {
            if (this.statusErrorOnClose) throw this.statusErrorOnClose;
        }
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

test("primes passive journal metadata before live events and status snapshots", async () => {
    const order = [];
    const journal = new FakeJournal([{ event: "DockingGranted" }], {
        statuses: [{ Flags: 1 }]
    });
    const runtime = new JournalRuntime({
        openJournal: async () => journal,
        onJournalReady: async ({ directory }) => {
            order.push(`ready:${directory}`);
        },
        onEvent: async () => order.push("event"),
        onStatus: async () => order.push("status")
    });

    runtime.start();
    await wait(15);
    assert.equal(order[0], "ready:C:/Fake/Journal");
    assert.deepEqual(new Set(order.slice(1)), new Set(["event", "status"]));
    await runtime.stop();
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

test("watches status snapshots and marks only the first snapshot as initial", async () => {
    const statusUpdates = [];
    const journal = new FakeJournal([], {
        statuses: [
            { timestamp: "2026-01-01T00:00:00Z", Flags: 1 },
            { timestamp: "2026-01-01T00:00:01Z", Flags: 16 }
        ]
    });
    const runtime = new JournalRuntime({
        openJournal: async () => journal,
        onEvent: async () => {},
        onStatus: async (status, metadata) => statusUpdates.push({
            flags: status.Flags,
            initial: metadata.initial
        })
    });

    runtime.start();
    await wait(15);

    assert.deepEqual(statusUpdates, [
        { flags: 1, initial: true },
        { flags: 16, initial: false }
    ]);

    await runtime.stop();
    assert.equal(journal.closed, true);
});

test("retries when the status watcher fails and marks the replacement snapshot as initial", async () => {
    const firstJournal = new FakeJournal([], {
        statusError: new SyntaxError("Malformed Status.json")
    });
    const replacementJournal = new FakeJournal([], {
        statuses: [{ timestamp: "2026-01-01T00:00:02Z", Flags: 4 }]
    });
    const journals = [firstJournal, replacementJournal];
    const statusUpdates = [];
    let attempts = 0;
    const runtime = new JournalRuntime({
        openJournal: async () => journals[attempts++],
        onEvent: async () => {},
        onStatus: async (status, metadata) => statusUpdates.push({
            flags: status.Flags,
            initial: metadata.initial
        }),
        retryDelaysMs: [5]
    });

    runtime.start();
    await wait(30);

    assert.equal(attempts, 2);
    assert.equal(firstJournal.closed, true);
    assert.equal(runtime.getStatus().state, "watching");
    assert.deepEqual(statusUpdates, [{ flags: 4, initial: true }]);

    await runtime.stop();
});

test("stop awaits a rejecting status watcher without surfacing an unhandled rejection", async () => {
    const journal = new FakeJournal([], {
        statuses: [{ timestamp: "2026-01-01T00:00:00Z", Flags: 0 }],
        statusErrorOnClose: new Error("Status watcher closed")
    });
    const runtime = new JournalRuntime({
        openJournal: async () => journal,
        onEvent: async () => {},
        onStatus: async () => {}
    });

    runtime.start();
    await wait(15);

    await assert.doesNotReject(runtime.stop());
    assert.equal(journal.closed, true);
    assert.equal(runtime.getStatus().state, "stopped");
});

test("stop is bounded when a partial Status watcher and journal close never settle", async () => {
    const never = () => new Promise(() => {});
    const hangingIterator = () => ({
        [Symbol.asyncIterator]() { return this; },
        next: never,
        return: never
    });
    const journal = {
        closed: false,
        getDirectory: () => "C:/Fake/HangingJournal",
        close() { this.closed = true; return never(); },
        [Symbol.asyncIterator]: hangingIterator,
        watchStatus: hangingIterator
    };
    const runtime = new JournalRuntime({
        openJournal: async () => journal,
        onEvent: async () => {},
        onStatus: async () => {},
        shutdownTimeoutMs: 10
    });

    runtime.start();
    await wait(5);
    const startedAt = Date.now();
    await runtime.stop();
    assert.ok(Date.now() - startedAt < 150, "stop should not wait indefinitely");
    assert.equal(journal.closed, true);
    assert.equal(runtime.getStatus().state, "stopped");
});
