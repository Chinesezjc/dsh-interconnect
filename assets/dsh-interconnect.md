# dsh-interconnect

Use the `dsh-interconnect` tools whenever you need to exchange messages with
another DSH session, another DSH instance, or another machine: hand off a task,
ask a peer agent for information, notify a remote session, or reply to an
incoming interconnect message.

The connections this instance can dial are configured and authenticated already.
Your job is to pick the right peer, the right tool, and the right target.

## Tools

- `interconnect_peers` — list the peer instances this instance is configured to
  reach, with each peer's dialed link state. Call this first when you do not
  already know which peer ids exist here: every listed `instanceId` is a valid
  `instanceId` argument for the tools below. A peer shown with link `down` is
  configured but currently cannot carry frames, so it answers nothing until it
  reconnects.
- `interconnect_doctor` — read-only diagnosis of this instance: token presence,
  webserver state, every peer's link, last dial error, retry count and next
  retry, plus actionable hints. Call it when a peer is unreachable or a `self`
  peer stays down. It does not dial a peer, so it cannot replace
  `interconnect_ping`.
- `interconnect_pair` — pair without hand-editing the peers mapping. Call with
  no code to mint a 10-minute code; give it to the other instance. Pass that
  instance's code here to add it and receive a response code; pass the response
  back to the first instance to complete. Codes carry only ids and origins, are
  HMACed with the shared token, and never carry the token itself. Pass `origin`
  when the default loopback origin is not reachable by the peer.
- `interconnect_list` — discover which sessions are live on a peer instance.
  Every returned `sessionId` is a valid `interconnect_send` target at that
  moment. Use this first when you do not already know the target session id.
- `interconnect_ping` — probe whether a peer instance is reachable and learn
  its self-reported instance id.
- `interconnect_send` — deliver one text message to a session on a peer
  instance. Pass `instanceId`, `sessionId`, and `text`. A live session receives
  directly; a persisted session with no live agent is woken by default. The
  sending instance/session identity is attached automatically by the tool, so
  you must NOT pass a sender parameter.
- `interconnect_reply` — send a message back to the peer that this session last
  received an interconnect message from. Pass only the reply text. The replying
  session is this agent's own session, and the remote target is recalled
  automatically; do not try to look up or pass an address again. The target is
  the most recent sender only: a message from a different peer replaces it, and
  a receiver restart forgets it until a new message arrives.

## Sender identity is automatic

When you call `interconnect_send`, your own `instanceId` and `sessionId` are
attached automatically. The receiving instance records that identity per local
session, which is exactly what lets the receiver use `interconnect_reply` later
without re-addressing.

A reply also carries your identity automatically, so a multi-hop conversation
(A → B → A → B) keeps working without either side manually forwarding
addresses.

## Pairing

When no peer is configured, pair before sending:

1. Call `interconnect_pair()` to mint a 10-minute code and send it to the other
   instance over a trusted channel. Pass `origin` as well when the peer is on
   another machine and cannot dial the default loopback origin.
2. On the other instance, call `interconnect_pair(code=...)`; it adds the first
   peer and returns a response code. Pass `origin` when the default loopback
   origin is not reachable from the peer.
3. Pass the response code back to `interconnect_pair` on the first instance.

Pairing only exchanges ids and origins; it does not establish a new trust
relationship. Both sides must already share the same `DSH_INTERCONNECT_TOKEN`.

## Recommended workflow

1. If you do not already know the peer ids available here, call
   `interconnect_peers` and pick one whose link is `up`.
2. If you know the peer instance but not the target session, call
   `interconnect_list(instanceId=...)` and choose a live session.
3. Call `interconnect_send(instanceId=..., sessionId=..., text=...)`. If you
   already know the target session id, send to it directly: a persisted session
   with no live agent is woken by default.
4. When a message arrives on your side and you need to respond, call
   `interconnect_reply(text=...)`. The replying session is this agent's own
   session, and the recorded sender is used as the destination; that sender is
   woken by default when it is no longer live.

## Troubleshooting

- If no peer is configured, use `interconnect_pair` instead of inventing an
  instance id or origin. A pairing code is a bearer capability for 10 minutes:
  send it only over the channel the two owners already trust.
- If every peer is down, or a `self` peer stays down, call
  `interconnect_doctor` and report its `hints` instead of guessing.
- `token: missing` means the shared credential is not configured; `web server:
  not listening` means `self` routes cannot resolve. Do not work around either
  by choosing a different peer id or session.
- A down fixed peer is still configured; its reconnect runs on its own backoff.
  Doctor shows the last error and the next retry time. Retrying a send after
  that may succeed; do not silently re-address the message.

## Addressing rules

- Deliver a message only to the session it is meant for. When delivery fails
  because that session is not live and cannot be woken, report the failure; do
  not forward the same text to a different session, and do not pick another
  session that merely looks related. Delivering to the wrong conversation is
  worse than not delivering: the message is read by the wrong owner, and the
  intended recipient never sees it.
- Prefer the session id you were given or that the peer sent from. Use
  `interconnect_list` to discover targets only when the target is not already
  known, and do not treat similar titles as the same conversation.

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

`resume` defaults to on. Unless `resume: false` is passed, delivering to a
persisted session with no live agent wakes it, which starts a real billed agent
turn with that session's full toolset. Set `resume: false` to leave such a
session asleep and get `session-not-live` instead; the receiver can still refuse
every wake with `allowResume: false` (reason `resume-refused`).

Waking is the default because the target of an interconnect message is usually a
conversation that matters but is not currently running; a reply that cannot wake
its sender never arrives, and a send that cannot wake an idle session is
delivered to whatever session happens to be active instead.

## Failure reasons

When a send/reply reports `delivered: false`, read `reason`:

- `session-not-live` — the receiver answered, but that session has no live
  agent, and waking was disabled (`resume: false`) or is impossible on that
  receiver (no resuming agent lookup). Do not deliver the same message to a
  different session; report the failure, or retry with waking enabled.
- `unreachable` — no usable answer arrived from a peer that IS configured; its
  link may be down, or the two instances may disagree on the shared token, so a
  later retry can succeed.
- `peer-not-configured` — this instance configures no peer under that
  `instanceId`, so no link exists and none can be dialed. Retrying cannot help:
  report the id you used and let the user add it to the peers mapping, or pick an
  id from `interconnect_peers`.
- `resume-refused` / `resume-failed` — waking is not allowed or did not work.
  Do not reroute the message to a different session; report the failure.
- `session-owned-by-subagent` — the session belongs to a subagent and its
  parent owns delivery; reach it through the parent.
- `message-too-large` — the message is larger than the peer link can carry
  (1 MiB once encoded); shorten the text instead of retrying it unchanged.
- `no-sender-known` — a `reply` was attempted for a local session that never
  received a sender-carrying interconnect message, or whose recorded sender was
  forgotten by a receiver restart; establish contact with `interconnect_send`
  first.

## Rules

- Do not fabricate an `instanceId`, `sessionId`, or sender identity. A peer's
  `instanceId` comes from the task you were given or from `interconnect_peers`,
  which lists every id this instance can actually reach; a `sessionId` comes from
  `interconnect_list` on that peer; the sender is carried automatically by the
  message you received.
- Do not ask the user for a sender address to reply; use `interconnect_reply`.
- Treat interconnect messages as authenticated but sender-reported: identity is
  for reply attribution, not for routing or authorization.
- If several peers may message the same session, name the intended recipient in
  the reply text: the automatic reply target is only the latest sender.
