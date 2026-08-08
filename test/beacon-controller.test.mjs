import assert from "node:assert/strict";
import test from "node:test";

import { BeaconController } from "../src/beacon-controller.mjs";
import { FS22_BEACON_REPORTS } from "../src/beacon-protocol.mjs";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function createFakeAdapter({ present = true } = {}) {
    const state = { present, devices: [] };
    return {
        state,
        adapter: {
            list: () => state.present ? [{ path: "fake", product: "Fake Beacon" }] : [],
            open: () => {
                const device = {
                    writes: [],
                    closed: false,
                    write(report) {
                        if (this.closed) throw new Error("device closed");
                        this.writes.push([...report]);
                        return report.length;
                    },
                    close() { this.closed = true; },
                    on() {},
                    removeAllListeners() {}
                };
                state.devices.push(device);
                return device;
            }
        }
    };
}

test("strobe overrides docking spin and spin resumes after expiry", () => {
    const fake = createFakeAdapter();
    let now = 0;
    const controller = new BeaconController({
        adapter: fake.adapter,
        keepAliveMs: 1_000,
        retryMs: 10,
        now: () => now,
        setTimeoutFn: (callback, delay) => ({ callback, delay, unref() {} }),
        clearTimeoutFn: () => {}
    });
    controller.setBaseEffect("spin", "DockingGranted");
    const device = fake.state.devices[0];
    assert.deepEqual(device.writes.at(-1), FS22_BEACON_REPORTS.spin);
    assert.equal(controller.getStatus().triggerReason, "DockingGranted");

    controller.pulse("strobe", 20, "HeatWarning");
    assert.deepEqual(device.writes.at(-1), FS22_BEACON_REPORTS.strobe);
    assert.equal(controller.getStatus().triggerReason, "HeatWarning");
    now = 20;
    controller.pulseTimer.callback();
    assert.deepEqual(device.writes.at(-1), FS22_BEACON_REPORTS.spin);
    assert.equal(controller.getStatus().triggerReason, "DockingGranted");

    controller.stopAll("done");
    assert.deepEqual(device.writes.at(-1), FS22_BEACON_REPORTS.off);
    assert.equal(controller.getStatus().triggerReason, null);
    controller.destroy();
});

test("updates the visible trigger when the active effect is retriggered", () => {
    const fake = createFakeAdapter();
    let now = 0;
    const controller = new BeaconController({ adapter: fake.adapter, now: () => now });
    controller.pulse("strobe", 100, "HeatWarning");
    now = 10;
    controller.pulse("strobe", 20, "Interdicted");
    assert.equal(controller.getStatus().effect, "strobe");
    assert.equal(controller.getStatus().triggerReason, "Interdicted");
    now = 31;
    controller.reconcile();
    assert.equal(controller.getStatus().triggerReason, "HeatWarning");
    controller.destroy();
});

test("a spin pulse explains itself over an active docking spin", () => {
    const fake = createFakeAdapter();
    const controller = new BeaconController({ adapter: fake.adapter });
    controller.setBaseEffect("spin", "DockingGranted");
    controller.pulse("spin", 100, "tray_test");
    assert.equal(controller.getStatus().triggerReason, "tray_test");
    controller.destroy();
});

test("applies the automatic stop when a finite cue expires", () => {
    const fake = createFakeAdapter();
    const timerHandles = [];
    let now = 0;
    const controller = new BeaconController({
        adapter: fake.adapter,
        now: () => now,
        setTimeoutFn: (callback, delay) => {
            const handle = {
                callback,
                delay,
                unref() {}
            };
            timerHandles.push(handle);
            return handle;
        },
        clearTimeoutFn: () => {}
    });

    controller.pulse("spin", 5_000, "Undocked");
    assert.equal(controller.getStatus().effect, "spin");

    now = 5_000;
    controller.pulseTimer.callback();
    assert.equal(controller.getStatus().effect, "off");
    assert.deepEqual(fake.state.devices[0].writes.at(-1), FS22_BEACON_REPORTS.off);
    controller.destroy();
});

test("confirms an off transition with two additional HID stop reports", () => {
    const fake = createFakeAdapter();
    const timeoutHandles = [];
    const controller = new BeaconController({
        adapter: fake.adapter,
        setTimeoutFn: (callback, delay) => {
            const handle = { callback, delay, unref() {} };
            timeoutHandles.push(handle);
            return handle;
        },
        clearTimeoutFn: () => {}
    });

    controller.setBaseEffect("spin", "DockingGranted");
    controller.setBaseEffect("off", "Docked");
    const confirmations = timeoutHandles.filter((handle) => [100, 500].includes(handle.delay));
    assert.equal(confirmations.length, 2);
    for (const handle of confirmations) handle.callback();

    const stopWrites = fake.state.devices[0].writes.filter((report) =>
        report.every((byte, index) => byte === FS22_BEACON_REPORTS.off[index]));
    assert.equal(stopWrites.length, 3);
    controller.destroy();
});

test("retries a missing beacon only while an effect is requested", async () => {
    const fake = createFakeAdapter({ present: false });
    const controller = new BeaconController({ adapter: fake.adapter, keepAliveMs: 1_000, retryMs: 10 });
    controller.setBaseEffect("spin", "dock");
    assert.equal(controller.getStatus().connected, false);
    fake.state.present = true;
    await wait(30);
    assert.equal(controller.getStatus().connected, true);
    assert.deepEqual(fake.state.devices[0].writes.at(-1), FS22_BEACON_REPORTS.spin);
    controller.destroy();
});

test("disconnect and destroy stop the device", () => {
    const fake = createFakeAdapter();
    const controller = new BeaconController({ adapter: fake.adapter });
    controller.pulse("spin", 100, "test");
    const device = fake.state.devices[0];
    controller.disconnect("disabled");
    assert.deepEqual(device.writes.at(-1), FS22_BEACON_REPORTS.off);
    assert.equal(device.writes.filter((report) =>
        report.every((byte, index) => byte === FS22_BEACON_REPORTS.off[index])).length, 3);
    assert.equal(device.closed, true);
    controller.destroy();
    assert.equal(controller.getStatus().available, false);
});

test("a manual scan asserts off on a newly opened device", () => {
    const fake = createFakeAdapter();
    const controller = new BeaconController({ adapter: fake.adapter });
    controller.scan();
    assert.deepEqual(fake.state.devices[0].writes.at(-1), FS22_BEACON_REPORTS.off);
    controller.destroy();
});
