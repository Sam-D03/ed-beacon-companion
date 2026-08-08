import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
    formatG560FrameCommand,
    G560BridgeProvider,
    G560_PRODUCT_ID,
    G560_PROTOCOL_ZONES,
    G560_VENDOR_ID,
    parseG560BridgeResponse
} from "../src/providers/g560-bridge-provider.mjs";

class FakeBridgeProcess extends EventEmitter {
    constructor(onCommand) {
        super();
        this.pid = 42;
        this.killed = false;
        this.stdin = new PassThrough();
        this.stdout = new PassThrough();
        this.stderr = new PassThrough();
        this.inputBuffer = "";
        this.stdin.setEncoding("utf8");
        this.stdin.on("data", (chunk) => {
            this.inputBuffer += chunk;
            let newline = this.inputBuffer.indexOf("\n");
            while (newline >= 0) {
                const line = this.inputBuffer.slice(0, newline).replace(/\r$/, "");
                this.inputBuffer = this.inputBuffer.slice(newline + 1);
                onCommand(line, this);
                newline = this.inputBuffer.indexOf("\n");
            }
        });
    }

    respond(line) {
        this.stdout.write(`${line}\n`);
    }

    exit(code = 0, signal = null) {
        queueMicrotask(() => this.emit("exit", code, signal));
    }

    kill() {
        this.killed = true;
        this.exit(null, "SIGTERM");
        return true;
    }
}

function createFakeBridge({ handleCommand = null } = {}) {
    const commands = [];
    let child = null;
    const spawnFn = () => {
        child = new FakeBridgeProcess((line, process) => {
            commands.push(line);
            if (handleCommand?.(line, process) === true) return;
            if (line.startsWith("ACQUIRE ")) process.respond("ACQUIRED sdk=9.2.65");
            else if (line.startsWith("FRAME ")) {
                const sequence = line.split(/\s+/)[1];
                process.respond(`FRAME_OK seq=${sequence}`);
            } else if (line.startsWith("RELEASE")) process.respond("RELEASED");
            else if (line === "QUIT") {
                process.respond("BYE");
                process.exit();
            }
        });
        queueMicrotask(() => child.respond("READY protocol=1"));
        return child;
    };
    return {
        commands,
        get child() { return child; },
        spawnFn
    };
}

const FRAME = Object.freeze({
    leftFront: [1, 2, 3],
    leftRear: [4, 5, 6],
    rightFront: [7, 8, 9],
    rightRear: [10, 11, 12]
});

test("G560 protocol fixes the canonical JavaScript zone order", () => {
    assert.deepEqual(G560_PROTOCOL_ZONES, ["leftFront", "leftRear", "rightFront", "rightRear"]);
    assert.equal(
        formatG560FrameCommand(27, FRAME),
        "FRAME 27 1 2 3 4 5 6 7 8 9 10 11 12"
    );
    assert.throws(
        () => formatG560FrameCommand(1, { ...FRAME, leftRear: [101, 0, 0] }),
        /Invalid leftRear red percentage/
    );
    assert.throws(
        () => formatG560FrameCommand(1, { ...FRAME, rightRear: [1, 2] }),
        /missing rightRear/
    );
});

test("G560 bridge responses parse acknowledgements and scoped failures", () => {
    assert.deepEqual(parseG560BridgeResponse("READY protocol=1"), {
        type: "ready",
        protocol: 1,
        line: "READY protocol=1"
    });
    assert.deepEqual(parseG560BridgeResponse("FRAME_DROPPED seq=8"), {
        type: "frame_dropped",
        sequence: 8,
        line: "FRAME_DROPPED seq=8"
    });
    assert.deepEqual(parseG560BridgeResponse("ERR frame sdk_write_failed seq=9 zone=2"), {
        type: "error",
        scope: "frame",
        code: "sdk_write_failed",
        sequence: 9,
        zone: 2,
        line: "ERR frame sdk_write_failed seq=9 zone=2"
    });
    assert.equal(parseG560BridgeResponse("x".repeat(1_025)).reason, "response_too_long");
});

test("provider acquires, writes, releases, and closes the bridge", async () => {
    const fake = createFakeBridge();
    const statusChanges = [];
    const provider = new G560BridgeProvider({
        bridgePath: "C:\\fake\\g560-bridge.exe",
        spawnFn: fake.spawnFn,
        existsSyncFn: () => true,
        platform: "win32",
        onStatusChange: (status) => statusChanges.push(status),
        requestTimeoutMs: 250,
        startupTimeoutMs: 250
    });

    assert.equal(await provider.connect(), true);
    assert.equal(provider.getStatus().sdkVersion, "9.2.65");
    const changesBeforeFrame = statusChanges.length;
    assert.equal(await provider.writeFrame(FRAME), true);
    assert.equal(statusChanges.length, changesBeforeFrame, "frame acknowledgements must not rebuild the tray menu");
    assert.equal(provider.getStatus().lastFrameSequence, 1);
    assert.equal(await provider.release("test_release"), true);
    await provider.destroy("test_destroy");

    assert.deepEqual(fake.commands, [
        "ACQUIRE ED Beacon Companion",
        "FRAME 1 1 2 3 4 5 6 7 8 9 10 11 12",
        "RELEASE test_release",
        "RELEASE test_destroy",
        "QUIT"
    ]);
    assert.equal(provider.getStatus().state, "destroyed");
});

test("reconnect waits for an in-flight release before acquiring again", async () => {
    let heldReleaseProcess = null;
    const fake = createFakeBridge({
        handleCommand(line, process) {
            if (line === "RELEASE serialized_release" && !heldReleaseProcess) {
                heldReleaseProcess = process;
                return true;
            }
            return false;
        }
    });
    const provider = new G560BridgeProvider({
        bridgePath: "C:\\fake\\g560-bridge.exe",
        spawnFn: fake.spawnFn,
        existsSyncFn: () => true,
        platform: "win32",
        requestTimeoutMs: 250,
        startupTimeoutMs: 250
    });

    await provider.connect();
    const release = provider.release("serialized_release");
    assert.equal(provider.getStatus().connected, false);
    assert.equal(provider.getStatus().state, "releasing");

    let reconnectSettled = false;
    const reconnect = provider.connect().finally(() => {
        reconnectSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reconnectSettled, false);
    assert.equal(fake.commands.filter((line) => line.startsWith("ACQUIRE ")).length, 1);

    heldReleaseProcess.respond("RELEASED");
    await release;
    assert.equal(await reconnect, true);
    assert.equal(fake.commands.filter((line) => line.startsWith("ACQUIRE ")).length, 2);
    assert.equal(provider.getStatus().connected, true);

    await provider.destroy("serialized_test_complete");
});

test("frame failures are correlated by sequence and a release remains possible", async () => {
    const fake = createFakeBridge({
        handleCommand(line, process) {
            if (!line.startsWith("FRAME ")) return false;
            const sequence = line.split(/\s+/)[1];
            process.respond(`ERR frame sdk_write_failed seq=${sequence} zone=1`);
            return true;
        }
    });
    const provider = new G560BridgeProvider({
        bridgePath: "C:\\fake\\g560-bridge.exe",
        spawnFn: fake.spawnFn,
        existsSyncFn: () => true,
        platform: "win32",
        requestTimeoutMs: 250,
        startupTimeoutMs: 250
    });

    await provider.connect();
    await assert.rejects(() => provider.writeFrame(FRAME), /sdk_write_failed/);
    assert.equal(provider.getStatus().connected, false);
    assert.equal(await provider.release("write_failed"), true);
    await provider.destroy();
    assert.ok(fake.commands.includes("RELEASE write_failed"));
});

test("an unexpected bridge exit rejects outstanding work and marks it disconnected", async () => {
    const fake = createFakeBridge({
        handleCommand(line) {
            return line.startsWith("FRAME ");
        }
    });
    const provider = new G560BridgeProvider({
        bridgePath: "C:\\fake\\g560-bridge.exe",
        spawnFn: fake.spawnFn,
        existsSyncFn: () => true,
        platform: "win32",
        requestTimeoutMs: 1_000,
        startupTimeoutMs: 250
    });

    await provider.connect();
    const pending = provider.writeFrame(FRAME);
    fake.child.exit(17);
    await assert.rejects(() => pending, /exited with code 17/);
    assert.equal(provider.getStatus().connected, false);
    assert.equal(provider.getStatus().state, "error");
});

test("provider refuses unsupported platforms and missing bridge executables", async () => {
    const unsupported = new G560BridgeProvider({ platform: "linux", existsSyncFn: () => false });
    await assert.rejects(() => unsupported.connect(), /only available on Windows/);

    const missing = new G560BridgeProvider({
        bridgePath: "C:\\missing\\g560-bridge.exe",
        platform: "win32",
        existsSyncFn: () => false
    });
    await assert.rejects(() => missing.connect(), /was not found/);
});

test("provider scans the G560 USB identity without opening it", async () => {
    const calls = [];
    const provider = new G560BridgeProvider({
        platform: "win32",
        listDevicesFn: (vendorId, productId) => {
            calls.push([vendorId, productId]);
            return [{ path: "speaker-interface" }];
        }
    });
    assert.equal(await provider.rescan(), true);
    assert.deepEqual(calls, [[G560_VENDOR_ID, G560_PRODUCT_ID]]);
    assert.equal(provider.getStatus().detected, true);
});

test("provider drops its connected flag before asynchronous SDK release completes", async () => {
    let releaseProcess = null;
    let delayNextRelease = true;
    const fake = createFakeBridge({
        handleCommand(line, process) {
            if (!line.startsWith("RELEASE") || !delayNextRelease) return false;
            delayNextRelease = false;
            releaseProcess = process;
            return true;
        }
    });
    const provider = new G560BridgeProvider({
        bridgePath: "C:\\fake\\g560-bridge.exe",
        spawnFn: fake.spawnFn,
        existsSyncFn: () => true,
        platform: "win32",
        requestTimeoutMs: 250,
        startupTimeoutMs: 250
    });
    await provider.connect();
    const releasePromise = provider.release("race_test");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(provider.getStatus().connected, false);
    assert.equal(provider.getStatus().state, "releasing");
    releaseProcess.respond("RELEASED");
    await releasePromise;
    await provider.destroy();
});

test("a frame acknowledgement arriving after release cannot reclaim connected state", async () => {
    let heldFrame = null;
    const fake = createFakeBridge({
        handleCommand(line, process) {
            if (!line.startsWith("FRAME ")) return false;
            heldFrame = { process, sequence: line.split(/\s+/)[1] };
            return true;
        }
    });
    const provider = new G560BridgeProvider({
        bridgePath: "C:\\fake\\g560-bridge.exe",
        spawnFn: fake.spawnFn,
        existsSyncFn: () => true,
        platform: "win32",
        requestTimeoutMs: 250,
        startupTimeoutMs: 250
    });

    await provider.connect();
    const frame = provider.writeFrame(FRAME);
    await new Promise((resolve) => setImmediate(resolve));
    await provider.release("release_during_frame");
    heldFrame.process.respond(`FRAME_DROPPED seq=${heldFrame.sequence}`);
    assert.equal(await frame, true);
    assert.equal(provider.getStatus().connected, false);
    assert.equal(provider.getStatus().state, "ready");
    await provider.destroy();
});

test("a timed-out release closes the native helper and permits a clean later retry", async () => {
    let suppressRelease = true;
    let firstChild = null;
    let heldReplacementAcquire = null;
    const fake = createFakeBridge({
        handleCommand(line, process) {
            if (line.startsWith("RELEASE") && suppressRelease) return true;
            if (line.startsWith("ACQUIRE ") && firstChild && process !== firstChild && !heldReplacementAcquire) {
                heldReplacementAcquire = process;
                return true;
            }
            return false;
        }
    });
    const provider = new G560BridgeProvider({
        bridgePath: "C:\\fake\\g560-bridge.exe",
        spawnFn: fake.spawnFn,
        existsSyncFn: () => true,
        platform: "win32",
        requestTimeoutMs: 100,
        startupTimeoutMs: 250,
        releaseCloseTimeoutMs: 25
    });

    await provider.connect();
    firstChild = fake.child;
    await assert.rejects(() => provider.release("stuck_release"), /Timed out/);
    assert.equal(firstChild.killed, true);
    assert.equal(provider.getStatus().connected, false);
    assert.equal(provider.getStatus().bridgePid, null);

    suppressRelease = false;
    let reconnectSettled = false;
    const reconnect = provider.connect().finally(() => { reconnectSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    firstChild.respond("ACQUIRED sdk=stale");
    firstChild.emit("error", new Error("stale child error"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reconnectSettled, false);
    heldReplacementAcquire.respond("ACQUIRED sdk=9.2.65");
    assert.equal(await reconnect, true);
    assert.notEqual(fake.child, firstChild);
    assert.equal(provider.getStatus().connected, true);
    await provider.destroy("retry_complete");
});

test("forced termination kills a stuck native bridge and rejects pending work", async () => {
    const fake = createFakeBridge({
        handleCommand(line) {
            return line.startsWith("FRAME ");
        }
    });
    const provider = new G560BridgeProvider({
        bridgePath: "C:\\fake\\g560-bridge.exe",
        spawnFn: fake.spawnFn,
        existsSyncFn: () => true,
        platform: "win32",
        requestTimeoutMs: 1_000,
        startupTimeoutMs: 250
    });
    await provider.connect();
    const pending = provider.writeFrame(FRAME);
    assert.equal(provider.forceTerminate("shutdown_timeout"), true);
    await assert.rejects(() => pending, /terminated: shutdown_timeout/);
    assert.equal(fake.child.killed, true);
    assert.equal(provider.getStatus().state, "destroyed");
    assert.equal(provider.getStatus().connected, false);
});
