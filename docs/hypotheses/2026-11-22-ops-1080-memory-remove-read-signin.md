# Ops #1080: Memory opens without a passkey sign-in; edits keep theirs

Owner Shine, Ops home chat 2026-11-22 (m103724): "can you remove the sign in with passkey on memory? if
they can reach pi they can ask for all of it anyways, no reason to guard it". Scope picked in
`dr-c54a3286d823`: "Remove sign-in only, keep for edits".

## Hypothesis (rule 14)

- **Problem and evidence:** every Memory visit starts with a passkey sign-in (R-OWNER-READ-1, a 15-min idle /
  4-h session cookie). Anyone who can reach pi-web-ui can already ask any chat to read the same memory, so the
  read sign-in costs the owner a prompt per visit and protects nothing he wants protected.
- **One change:** reads stop asking for a session (the gate answers yes to a read; the Host/Origin
  dot check stays); the read-session machinery is deleted (session store, cookie, `session/*` routes,
  Sign in / Sign out UI). Writes keep one fresh passkey assertion bound to the exact operation
  (R-OWNER-WRITE-1/2), now bound to the host instead of to a session. A public `GET owner/passkeys` lists
  this host's passkeys (id, host, date only) so the Passkeys box works without a session, and a write on a
  host with no passkey opens "Add a passkey" and then finishes the write.
- **Expected result + measurement:** server tests: the 5 explorer read routes answer 200 with no cookie;
  `session/options|verify|logout` answer 404; `note` PUT/DELETE, `undo` and `DELETE passkey` still answer
  `403 OWNER_ONLY` without a fresh op-bound assertion and 200 with one; `GET owner/passkeys` never carries
  `public_key`. UI tests: the page shows notes on first load with 0 sign-in prompts and 0 Sign in / Sign out
  buttons; Save asks for the passkey; on a 0-passkey host Save opens Add a passkey and then saves.
  Live: the Memory tab on pi.wai2shine.com shows notes with no prompt (pi-web-ui-live-look).
- **What proves it wrong:** any read route still answering 403 to a well-formed request with no cookie, any
  write passing without an assertion, a `public_key` in any passkeys answer, or the live page showing a
  sign-in prompt.

## Residual (recorded, not solved)

- `write/options` no longer needs a session, so anyone who can reach pi can ask for an undo's confirmation
  and so freeze (and, unconfirmed, cancel) a held delete (R-OWNER-UNDO-1). That is the safe direction (the
  note is kept) and needs the operation id; same reach as the owner's premise above.

## Result

Filled in at land (hit/miss with the numbers).
