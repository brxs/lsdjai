# Architecture Decision Records

This directory holds **Architecture Decision Records (ADRs)** - short documents
that capture a significant decision, the context that forced it, and the
consequences we accepted.

Record a decision here when it is hard to reverse, affects more than one team or
component, or a future reader would reasonably ask "why was it done this way?".
Routine, easily-reversible choices do not need an ADR.

## Conventions

- One file per decision, named `NNNN-short-title.md` (zero-padded, sequential).
- `0001` onward; never renumber or delete an ADR.
- An ADR is immutable once **Accepted**. To change a decision, write a new ADR
  and set the old one's status to `Superseded by ADR-NNNN`.
- Use [`template.md`](template.md) as the starting point.

## Creating one

Use the `write-adr` skill - it picks the next number, fills in the date, and
scaffolds the file from the template.

## Index

| ADR | Title | Status |
| --- | ----- | ------ |
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-browser-app-with-python-model-workers.md) | Browser app with Python model workers, deferring Tauri | Accepted |
| [0003](0003-frontend-audio-mixing-via-web-audio.md) | Frontend audio mixing via Web Audio | Accepted |
