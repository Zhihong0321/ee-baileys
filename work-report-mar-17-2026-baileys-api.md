DATE  : Mar 17, 2026
REPO NAME : baileys-api

- Fixed WhatsApp inbound message loss for first-contact senders by creating missing leads and restoring Postgres writes
- Added a durable Postgres inbound inbox and retry processing so WhatsApp messages are queued before lead matching or media download
- Added an inbound message simulation endpoint that writes a fake WhatsApp inbound event and returns the resulting inbox and et_messages records
- Added a dashboard UI for inbound WhatsApp simulation with trigger status and DB result visibility

=====================
