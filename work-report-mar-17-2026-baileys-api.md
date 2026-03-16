DATE  : Mar 17, 2026
REPO NAME : baileys-api

- Fixed WhatsApp inbound message loss for first-contact senders by creating missing leads and restoring Postgres writes
- Added a durable Postgres inbound inbox and retry processing so WhatsApp messages are queued before lead matching or media download

=====================
