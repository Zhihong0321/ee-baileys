# Message Schema - Final Design

## Schema Overview

Two tables:
1. `et_threads` - Conversation threads
2. `et_messages` - All messages (inbound + outbound)

Thread assignment is automatic via PostgreSQL trigger.

---

## Table 1: et_threads

```sql
CREATE TABLE et_threads (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL,
    lead_id INTEGER NOT NULL,
    channel VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_threads_lead ON et_threads(lead_id);
CREATE INDEX idx_threads_active ON et_threads(lead_id, channel, status);
```

### Columns:
- `id` - Thread ID (auto-increment)
- `tenant_id` - Company ID
- `lead_id` - Contact ID
- `channel` - "whatsapp", "email", "discord", "telegram"
- `status` - "active" or "archived"
- `created_at` - When thread was created

---

## Table 2: et_messages

```sql
CREATE TABLE et_messages (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL,
    lead_id INTEGER NOT NULL,
    thread_id INTEGER,
    channel VARCHAR(50) NOT NULL,
    message_id VARCHAR(255) NOT NULL,
    timestamp BIGINT NOT NULL,
    direction VARCHAR(20) NOT NULL,
    message_type VARCHAR(50) NOT NULL DEFAULT 'text',
    text_content TEXT,
    media_url TEXT,
    raw_json JSONB NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    
    UNIQUE(channel, lead_id, message_id)
);

CREATE INDEX idx_msg_tenant ON et_messages(tenant_id);
CREATE INDEX idx_msg_lead ON et_messages(lead_id);
CREATE INDEX idx_msg_thread ON et_messages(thread_id);
CREATE INDEX idx_msg_conversation ON et_messages(thread_id, timestamp);
```

### Columns:
- `id` - Message ID (auto-increment)
- `tenant_id` - Company ID
- `lead_id` - Contact ID
- `thread_id` - Thread ID (auto-assigned by trigger)
- `channel` - "whatsapp", "email", "discord", "telegram"
- `message_id` - Platform message ID (for deduplication)
- `timestamp` - Unix epoch milliseconds
- `direction` - "inbound" or "outbound"
- `message_type` - "text", "image", "video", "audio", "document"
- `text_content` - Message text (nullable)
- `media_url` - Media URL (nullable)
- `raw_json` - Full platform message object
- `created_at` - When stored in DB

---

## Auto-Thread Assignment Trigger

```sql
CREATE OR REPLACE FUNCTION assign_thread()
RETURNS TRIGGER AS $$
DECLARE
    v_thread_id INTEGER;
BEGIN
    -- Find active thread for this lead + channel
    SELECT id INTO v_thread_id
    FROM et_threads
    WHERE lead_id = NEW.lead_id 
      AND channel = NEW.channel
      AND status = 'active'
    LIMIT 1;
    
    -- If no active thread, create one
    IF v_thread_id IS NULL THEN
        INSERT INTO et_threads (tenant_id, lead_id, channel)
        VALUES (NEW.tenant_id, NEW.lead_id, NEW.channel)
        RETURNING id INTO v_thread_id;
    END IF;
    
    -- Assign thread_id to message
    NEW.thread_id := v_thread_id;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tr_assign_thread
BEFORE INSERT ON et_messages
FOR EACH ROW
EXECUTE FUNCTION assign_thread();
```

---

## What Baileys (and all channel APIs) Must Do

**Simple: Just insert messages. No thread logic.**

```sql
INSERT INTO et_messages (
    tenant_id,
    lead_id,
    channel,
    message_id,
    timestamp,
    direction,
    message_type,
    text_content,
    raw_json
) VALUES (
    101,                -- tenant_id
    5001,               -- lead_id
    'whatsapp',         -- channel
    '3EB0ABC123',       -- message_id
    1708186800000,      -- timestamp
    'inbound',          -- direction
    'text',             -- message_type
    'Hello',            -- text_content
    '{"key":{"id":"3EB0ABC123"},"message":{"conversation":"Hello"}}'::jsonb
);
```

**Trigger automatically:**
1. Finds active thread for lead_id + channel
2. If no thread exists, creates new thread
3. Assigns thread_id to message

---

## Query Conversation History (for RAG)

```sql
-- Get all messages in a thread (chronological)
SELECT *
FROM et_messages
WHERE thread_id = 123
ORDER BY timestamp ASC;
```

or

```sql
-- Get all messages for a lead across all active threads
SELECT m.*
FROM et_messages m
JOIN et_threads t ON m.thread_id = t.id
WHERE m.lead_id = 5001
  AND t.status = 'active'
ORDER BY m.timestamp ASC;
```

---

## Archive/Reset Thread

To start a fresh conversation:

```sql
-- Archive old thread
UPDATE et_threads
SET status = 'archived'
WHERE id = 123;

-- Next message will auto-create new thread
```

---

## Summary for Baileys Team

**You only need to:**
1. INSERT messages into `et_messages` table
2. Don't worry about `thread_id` - leave it NULL
3. Trigger handles everything

**Database connection:**
- Environment variable: `DATABASE_URL`
- Format: `postgresql://user:password@host:5432/chatbot_db`

**Check for duplicates before insert:**
```sql
SELECT id FROM et_messages
WHERE channel = 'whatsapp'
  AND lead_id = 5001
  AND message_id = '3EB0ABC123';
```

If exists: skip. If not: insert.

Done.
