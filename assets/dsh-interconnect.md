# dsh-interconnect

Use the `dsh-interconnect` tools whenever you need to exchange messages with
another DSH session, another DSH instance, or another machine: hand off a task,
ask a peer agent for information, notify a remote session, or reply to an
incoming interconnect message.

The transport is already connected and authenticated by the host plugin. Your
job is only to pick the right tool and the right target.

## Tools

- `interconnect_list` — discover which sessions are live on a peer instance.
  Every returned `sessionId` is a valid `interconnect_send` target at that
  moment. Use this first when you do not already know the target session id.
- `interconnect_ping` — probe whether a peer instance is reachable and learn
  its self-reported instance id.
- `interconnect_send` — deliver one text message to a live session on a peer
  instance. Pass `instanceId`, `sessionId`, and `text`. The sending
  instance/session identity is attached automatically by the tool, so you must
  NOT pass a sender parameter.
- `interconnect_reply` — send a message back to the peer that this session last
  received an interconnect message from. Pass only the LOCAL session id that
  received the message and the reply text. The remote target is recalled
  automatically; do not try to look up or pass the sender address again.

## Sender identity is automatic

When you call `interconnect_send`, the plugin automatically attaches your own
`instanceId` and `sessionId` to the wire payload. The receiving instance
records that identity per local session, which is exactly what lets the
receiver use `interconnect_reply` later without re-addressing.

A reply also carries your identity automatically, so a multi-hop conversation
(A → B → A → B) keeps working without either side manually forwarding
addresses.

## Recommended workflow

1. If you know the peer instance but not the target session, call
   `interconnect_list(instanceId=...)` and choose a live session.
2. Call `interconnect_send(instanceId=..., sessionId=..., text=...)`.
3. When a message arrives on your side and you need to respond, call
   `interconnect_reply(sessionId=<your-local-session-id>, text=...)`. The
   recorded sender is used as the destination.

## Delivery modes

The `delivery` parameter is per-message urgency:

- `followup` — queues the message as its own turn after whatever the receiver
  is doing now.
- `steer` — cuts into the nearest step boundary of a running turn; use for
  urgent interruptions.
- `inject` — only writes the message into context, without waking an idle
  agent; it may sit unread.

Omit `delivery` to use the receiver's configured default.

## Waking offline sessions

`resume` defaults to off. Setting `resume: true` asks the receiver to wake a
persisted but not-running session, which starts a real billed agent turn with
that session's full toolset. Only use it when the specific session must be
reached and the receiver allows it. Prefer `interconnect_list` and an
already-live target when possible.

## Failure reasons

When a send/reply reports `delivered: false`, read `reason`:

- `session-not-live` — the receiver answered, but that session has no running
  agent. Use `interconnect_list` to choose another target, or consider
  `resume`.
- `unreachable` — no usable answer arrived; the target may still be fine, so a
  retry can succeed.
- `resume-refused` / `resume-failed` — waking is not allowed or did not work;
  choose a live target instead.
- `session-owned-by-subagent` — the session belongs to a subagent and its
  parent owns delivery; reach it through the parent.
- `no-sender-known` — a `reply` was attempted for a local session that never
  received a sender-carrying interconnect message; establish contact with
  `interconnect_send` first.

## Rules

- Do not fabricate an `instanceId`, `sessionId`, or sender identity. Use values
  returned by `interconnect_list`, `interconnect_ping`, or already recorded by
  the service.
- Do not ask the user for a sender address to reply; use `interconnect_reply`.
- Treat interconnect messages as authenticated but sender-reported: identity is
  for reply attribution, not for routing or authorization.
