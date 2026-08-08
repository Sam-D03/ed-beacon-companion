import assert from "node:assert/strict";
import test from "node:test";

import { EliteProcessMonitor, queryEliteProcess } from "../src/elite-process-monitor.mjs";

test("tasklist probe recognises only the Elite Dangerous game process", async () => {
    const running = await queryEliteProcess({
        platform: "win32",
        execFileFn: (_file, _args, _options, callback) => callback(null, '"EliteDangerous64.exe","17100","Console","1","1,234,567 K"\r\n')
    });
    const absent = await queryEliteProcess({
        platform: "win32",
        execFileFn: (_file, _args, _options, callback) => callback(null, "INFO: No tasks are running which match the specified criteria.\r\n")
    });
    assert.equal(running, true);
    assert.equal(absent, false);
    assert.equal(await queryEliteProcess({ platform: "linux" }), false);
});

test("monitor emits only process transitions and stops its recurring timer", async () => {
    const answers = [false, false, true, false];
    const transitions = [];
    const timers = [];
    const monitor = new EliteProcessMonitor({
        probe: async () => answers.shift(),
        onChange: async (running) => transitions.push(running),
        intervalMs: 500,
        setTimeoutFn: (callback, delay) => {
            const timer = { callback, delay, cleared: false, unref() {} };
            timers.push(timer);
            return timer;
        },
        clearTimeoutFn: (timer) => { timer.cleared = true; }
    });

    await monitor.start();
    assert.deepEqual(transitions, [false]);
    assert.equal(timers.at(-1).delay, 500);
    await timers.at(-1).callback();
    assert.deepEqual(transitions, [false]);
    await timers.at(-1).callback();
    assert.deepEqual(transitions, [false, true]);
    await timers.at(-1).callback();
    assert.deepEqual(transitions, [false, true, false]);
    await monitor.stop();
    assert.equal(timers.at(-1).cleared, true);
    assert.equal(monitor.getStatus().state, "stopped");
    assert.equal(monitor.getStatus().running, null);
});

test("restarting monitoring republishes current liveness for a re-enabled companion", async () => {
    const transitions = [];
    const monitor = new EliteProcessMonitor({
        probe: async () => true,
        onChange: (running) => transitions.push(running),
        setTimeoutFn: () => ({ unref() {} }),
        clearTimeoutFn: () => {}
    });
    await monitor.start();
    await monitor.stop();
    await monitor.start();
    assert.deepEqual(transitions, [true, true]);
    await monitor.stop();
});

test("monitor retains its last process truth across transient probe failures", async () => {
    let fail = false;
    const monitor = new EliteProcessMonitor({
        probe: async () => {
            if (fail) throw new Error("tasklist unavailable");
            return true;
        },
        setTimeoutFn: () => ({ unref() {} }),
        clearTimeoutFn: () => {}
    });
    await monitor.start();
    fail = true;
    assert.equal(await monitor.checkNow(), true);
    assert.equal(monitor.getStatus().running, true);
    assert.equal(monitor.getStatus().state, "error");
    await monitor.stop();
});
