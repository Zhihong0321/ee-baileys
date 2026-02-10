# Baileys Multi-Session API Research (v7.0.0-rc.9+)

## 🚀 Project Overview
Goal: Build a robust, multi-instance WhatsApp API server for personal accounts using the Baileys library, integrated with an AI chatbot via webhooks.

## 📦 Library Status (WhiskeySockets/Baileys)
- **Latest Version**: `v7.0.0-rc.9` (Released Nov 2025)
- **Key Paradigm**: Pure WebSocket-based communication (no Puppeteer/Chrome required).
- **CRITICAL CHANGE**: Transition from **JID** (phone-based) to **LID** (identity-based) is the primary breaking change in v7.

---

## 🚩 IDENTIFIED HURDLES (CRITICAL)

### 1. JID to LID Migration (High Importance)
*   **The Issue**: WhatsApp is decoupling "phone numbers" from "identities". Your bot may receive a message from an ID like `12345@lid` instead of `12345@s.whatsapp.net`.
*   **The Impact**: Replies sent to the wrong ID type will fail or vanish.
*   **🔥 Mitigation**: 
    - Use the new `lid-mapping.update` event to maintain a local database of Phone Number <-> LID relationships.
    - Use identity-agnostic logic when sending messages.

### 2. Encryption & Session Integrity ("Bad MAC")
*   **The Issue**: Encryption errors like `Stream Error: Bad MAC`.
*   **The Cause**: Race conditions during high-volume message bursts where credentials update faster than the disk can write.
*   **🔥 Mitigation**: 
    - **MANDATORY**: Ensure the state includes new v7 keys: `lid-mapping`, `device-list`, and `tctoken`.
    - Use a **Mutex (lock)** during `creds.update` to prevent corruption.

### 3. Startup Concurrency (The "Banning" Risk)
*   **The Issue**: Connecting 5+ accounts at the exact same millisecond looks like a bot attack to WhatsApp.
*   **🔥 Mitigation**: Implement **Staggered Initialization** (e.g., a 3-5 second delay between account connections).

### 4. Webhook Deduplication
*   **The Issue**: Baileys re-emits messages upon reconnection.
*   **🔥 Mitigation**: Hash and store `msg.key.id` for 60 seconds. Reject duplicates before hitting the AI Chatbot.

---

## 🛠️ NEW TECHNICAL DISCOVERIES (v7 Deep Dive)

### 🧩 Mandatory Auth Keys
For v7 stability, if building a custom database store, you **MUST** include these keys in your schema:
1.  `lid-mapping`
2.  `device-list`
3.  `tctoken`
*(Failure to persist these will result in immediate logouts after restart).*

### 🔔 iPhone Notification Bug
- **Bug**: Recipients on iPhones may intermittently stop receiving notifications from the bot.
- **Workaround**: Encourage users to "Link a new device" if the session becomes stale, or use the `pairing code` method for higher reliability.

### 🔗 Pairing Code Support
- Baileys v7 now supports linking via **Pairing Code** (No QR scan needed). This is useful for headless servers where viewing a terminal QR is difficult.

---

## 📋 VERIFICATION CHECKLIST
- [ ] Implement `lid-mapping.update` listener.
- [ ] Implement `msg.key.id` deduplication.
- [ ] Add 3-second delay between session initializations.
- [ ] Verify `lid-mapping` is persisting in session files.
- [ ] Test reply logic with both JID and LID users.

