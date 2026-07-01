import test from "node:test";
import assert from "node:assert/strict";

import {
  filterSessionMaterialEvents,
  isSessionControlEvent,
  isSessionListenerLifecycleEvent,
} from "../src/session/control-events.js";

test("Unit control events: classifies listener lifecycle and Senti control traffic", () => {
  const controls = [
    { event: "session_listener_started" },
    { event: "session_listener_heartbeat" },
    { event: "session_listener_stopped" },
    { event: "listener_stop" },
    { event: "session_coaching" },
    { event: "session_listen_catchup" },
    { event: "session_listen_error" },
    { event: "session_message", payload: { source: "session_listen", message: "tip" } },
    { event: "file_lock" },
    { event: "file_unlock" },
    { event: "file_lock_expired" },
    { event: "session_action", payload: { actionType: "ack" } },
    { event: "session_action", payload: { actionType: "view" } },
    { event: "session_action", payload: { actionType: "like" } },
    { event: "session_reaction", payload: { actionType: "ack" } },
  ];

  for (const event of controls) {
    assert.equal(isSessionControlEvent(event), true, `${event.event} should be control`);
  }
});

test("Unit control events: keeps material chat/action traffic visible", () => {
  const material = [
    { event: "session_message", payload: { message: "work update" } },
    { event: "agent_response", payload: { response: "done" } },
    { event: "session_action", payload: { actionType: "working_on", note: "reviewing live deploy" } },
    { event: "session_reply", payload: { message: "review complete" } },
  ];

  for (const event of material) {
    assert.equal(isSessionControlEvent(event), false, `${event.event} should be material`);
  }
  assert.deepEqual(filterSessionMaterialEvents([...material, { event: "listener_stop" }]), material);
});

test("Unit control events: listener lifecycle skip does not swallow stop directives", () => {
  assert.equal(isSessionListenerLifecycleEvent({ event: "session_listener_heartbeat" }), true);
  assert.equal(isSessionListenerLifecycleEvent({ event: "session_coaching", payload: { source: "session_listen" } }), true);
  assert.equal(isSessionListenerLifecycleEvent({ event: "listener_stop" }), false);
  assert.equal(isSessionControlEvent({ event: "listener_stop" }), true);
});
